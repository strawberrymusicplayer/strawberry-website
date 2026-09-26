#!/usr/bin/env python3
"""
Create a new Strawberry release post on Patreon.

Patreon's public API (v2) can't create posts, so this uses the same internal API as the patreon.com web editor, authenticated with a browser session cookie (PATREON_COOKIE).
It is undocumented and may break when Patreon changes it.

The post body is generated from the GitHub release notes (Markdown) with a link to the GitHub release.
The post is created as a shop product with a price, unlockable by purchase or by any paid tier.
Tags and collections are copied from the previous release post, and the given files are uploaded as attachments.

Prints the new post URL on stdout.
"""

import argparse
import html
import json
import os
import re
import sys
import time
import urllib.parse
from datetime import datetime

import requests

BASE_URL = 'https://www.patreon.com'
API_QUERY = 'json-api-version=1.0&json-api-use-default-includes=false'
GITHUB_REPO_URL = 'https://github.com/strawberrymusicplayer/strawberry'
USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
# (connect, read) timeouts in seconds, the bucket upload sends the whole file.
REQUEST_TIMEOUT = (10, 60)
UPLOAD_TIMEOUT = (10, 600)
# Pages of 20 posts searched for an existing post, before giving up.
MAX_SEARCH_PAGES = 10



def log(msg):
  print(msg, file=sys.stderr, flush=True)


class HTTPError(RuntimeError):

  def __init__(self, status_code, message):
    super().__init__(message)
    self.status_code = status_code


class Patreon:

  def __init__(self, cookie, deadline=None):
    self.deadline = deadline
    self.session = requests.Session()
    self.session.headers.update({
      'User-Agent': USER_AGENT,
      'Cookie': cookie,
      'Accept': 'application/vnd.api+json',
    })
    self.csrf = None

  def timeout(self, timeout):
    # Limit a (connect, read) timeout to the time left before the deadline.
    if self.deadline is None:
      return timeout
    remaining = self.deadline - time.time()
    if remaining <= 0:
      raise RuntimeError('Ran out of time, see --timeout-minutes.')
    return tuple(min(t, remaining) for t in timeout)

  def login(self):
    results = []
    for path in ('/home', '/membership'):
      r = self.session.get(BASE_URL + path, headers={'Accept': 'text/html'}, timeout=self.timeout(REQUEST_TIMEOUT))
      for pattern in (r'<meta name="csrf-token" content="([^"]+)"', r'"csrfSignature"\s*:\s*"([^"]+)"'):
        m = re.search(pattern, r.text)
        if m:
          self.csrf = m.group(1)
          self.session.headers['X-CSRF-Signature'] = self.csrf
          return
      results.append(login_result(path, r.status_code, r.url, r.text, r.headers))
    raise RuntimeError(f'Could not find CSRF token ({"; ".join(results)}).')

  def request(self, method, url, **kwargs):
    if not url.startswith('http'):
      url = BASE_URL + url
    kwargs['timeout'] = self.timeout(kwargs.get('timeout', REQUEST_TIMEOUT))
    r = self.session.request(method, url, **kwargs)
    if r.status_code >= 400:
      raise HTTPError(r.status_code, f'{method} {url} failed with HTTP {r.status_code}: {r.text[:2000]}')
    return r.json() if r.content else None

  def get_post(self, post_id):
    return self.request('GET', f'/api/posts/{post_id}?include=campaign,access_rules,user_defined_tags,collections&{API_QUERY}')

  def find_post_by_title(self, campaign_id, title, since=None):
    # Search the published posts newest first, a post with the title can't be older than since (the previous release post).
    since = parse_time(since)
    cursor = None
    for _ in range(MAX_SEARCH_PAGES):
      url = f'/api/posts?filter[campaign_id]={campaign_id}&filter[contains_exclusive_posts]=true&filter[is_draft]=false&sort=-published_at&fields[post]=title,url,published_at&page[count]=20&{API_QUERY}'
      if cursor:
        url += f'&page[cursor]={urllib.parse.quote(cursor, safe="")}'
      posts = self.request('GET', url)
      for post in posts['data']:
        if post['attributes'].get('title') == title:
          return post
        published_at = parse_time(post['attributes'].get('published_at'))
        if since and published_at and published_at < since:
          return None
      cursor = ((posts.get('meta') or {}).get('pagination') or {}).get('cursors', {}).get('next')
      if not cursor or not posts['data']:
        return None
    raise RuntimeError(f'Searched {MAX_SEARCH_PAGES} pages of posts without reaching the previous release post, not creating a possible duplicate.')

  def get_paid_tier_access_rules(self, campaign_id):
    campaign = self.request('GET', f'/api/campaigns/{campaign_id}?include=access_rules.tier.null&fields[access-rule]=access_rule_type,amount_cents&fields[reward]=title,amount_cents,published,is_free_tier&{API_QUERY}')
    tiers = {item['id']: item['attributes'] for item in campaign.get('included', []) if item['type'] == 'reward'}
    rules = []
    for item in campaign.get('included', []):
      if item['type'] != 'access-rule' or item['attributes'].get('access_rule_type') != 'tier':
        continue
      tier = tiers.get((item.get('relationships', {}).get('tier', {}).get('data') or {}).get('id'))
      if tier and tier.get('amount_cents', 0) > 0 and not tier.get('is_free_tier') and tier.get('published', True):
        log(f'Paid tier: {tier.get("title")} ({tier["amount_cents"] / 100:.2f}), access rule {item["id"]}')
        rules.append(item['id'])
    if not rules:
      raise RuntimeError('Found no paid tiers in the campaign.')
    return sorted(rules, key=int)

  def create_post(self):
    # Created from the shop as a product.
    data = {'data': {'type': 'post', 'attributes': {'purchase_only': True}}}
    return self.request('POST', f'/api/posts?fields[post]=post_type,post_metadata&include=drop&{API_QUERY}', json=data)

  def delete_post(self, post_id):
    self.request('DELETE', f'/api/posts/{post_id}?{API_QUERY}')

  def upload_attachment(self, post_id, path):
    file_name = os.path.basename(path)
    size = os.path.getsize(path)
    log(f'Uploading {file_name} ({size} bytes)')
    data = {
      'data': {
        'type': 'media',
        'attributes': {
          'state': 'pending_upload',
          'file_name': file_name,
          'size_bytes': size,
          'owner_id': post_id,
          'owner_type': 'post',
          'owner_relationship': 'attachment',
        },
      },
    }
    media = self.request('POST', f'/api/media?include=[]&{API_QUERY}', json=data)['data']
    attributes = media['attributes']

    # Upload to the storage bucket using the pre-signed form fields.
    with open(path, 'rb') as f:
      r = requests.post(attributes['upload_url'], data=attributes['upload_parameters'], files={'file': (file_name, f)}, headers={'User-Agent': USER_AGENT}, timeout=self.timeout(UPLOAD_TIMEOUT))
    if r.status_code >= 400:
      raise RuntimeError(f'Uploading {file_name} to bucket failed with HTTP {r.status_code}: {r.text[:2000]}')

    timeout = time.time() + 900
    while time.time() < timeout:
      state = self.request('GET', f'/api/media/{media["id"]}?include=[]&{API_QUERY}')['data']['attributes']['state']
      if state == 'ready':
        return media['id']
      if state == 'failed':
        raise RuntimeError(f'Patreon failed processing {file_name}')
      time.sleep(5)
    raise RuntimeError(f'Timeout waiting for Patreon to process {file_name}')

  def finalize_post(self, post_id, data):
    self.request('PATCH', f'/api/posts/{post_id}?include=[]&{API_QUERY}', json=data)

  def get_post_price_cents(self, post_id):
    post = self.request('GET', f'/api/posts/{post_id}?include=content_unlock_options.product_variant.null&fields[post]=is_monetized,paywall_display&fields[content-unlock-option]=content_unlock_type&fields[product-variant]=price_cents,currency_code&{API_QUERY}')
    for item in post.get('included', []):
      if item['type'] == 'product-variant':
        return item['attributes'].get('price_cents')
    return None


def login_result(path, status_code, url, text, headers):
  # Why a login page had no CSRF token, without anything from the cookie.
  hints = []
  if '/login' in urllib.parse.urlparse(url).path:
    hints.append('redirected to login, the session cookie is expired or logged out')
  if headers.get('cf-mitigated') == 'challenge' or 'Just a moment' in text:
    hints.append('Cloudflare challenge')
  return f'{path}: HTTP {status_code}' + (f', {", ".join(hints)}' if hints else '')


def parse_time(value):
  return datetime.fromisoformat(value) if value else None


INLINE_RE = re.compile(r'\[([^\]]+)\]\(([^)\s]+)\)|\*\*(.+?)\*\*|`([^`]+)`|(https?://[^\s)]+)|(?<![\w&])#(\d+)\b')


def parse_inline(text):
  """Parse Markdown inline text into a list of (text, bold, href)."""

  parts = []
  pos = 0
  for m in INLINE_RE.finditer(text):
    if m.start() > pos:
      parts.append((text[pos:m.start()], False, None))
    link_text, link_url, bold, code, url, issue = m.groups()
    if link_text:
      # Only link to web pages, other schemes like javascript: are kept as plain text.
      parts.append((link_text, False, link_url if re.match(r'https?://', link_url, re.IGNORECASE) else None))
    elif bold:
      parts.append((bold, True, None))
    elif code:
      parts.append((code, False, None))
    elif url:
      parts.append((url, False, url))
    else:
      parts.append((f'#{issue}', False, f'{GITHUB_REPO_URL}/issues/{issue}'))
    pos = m.end()
  if pos < len(text):
    parts.append((text[pos:], False, None))
  return parts


def parse_markdown(markdown):
  """Parse the GitHub release notes into blocks: ('heading', level, inline), ('list', [inline]) or ('paragraph', inline)."""

  blocks = []
  for line in markdown.replace('\r\n', '\n').split('\n'):
    line = line.rstrip()
    if not line.strip():
      if blocks and blocks[-1][0] == 'paragraph':
        blocks.append(('break',))
      continue
    heading = re.match(r'^(#{1,6})\s+(.*)$', line)
    item = re.match(r'^\s*[-*+]\s+(.*)$', line)
    if heading:
      blocks.append(('heading', min(len(heading.group(1)), 3), parse_inline(heading.group(2).strip())))
    elif item:
      if blocks and blocks[-1][0] == 'list':
        blocks[-1][1].append(parse_inline(item.group(1).strip()))
      else:
        blocks.append(('list', [parse_inline(item.group(1).strip())]))
    elif blocks and blocks[-1][0] == 'paragraph':
      blocks[-1] = ('paragraph', blocks[-1][1] + [(' ', False, None)] + parse_inline(line.strip()))
    elif blocks and blocks[-1][0] == 'list' and line.startswith((' ', '\t')):
      blocks[-1][1][-1] += [(' ', False, None)] + parse_inline(line.strip())
    else:
      blocks.append(('paragraph', parse_inline(line.strip())))
  return [block for block in blocks if block[0] != 'break']


def inline_html(parts):
  result = ''
  for text, bold, href in parts:
    text = html.escape(text)
    if bold:
      text = f'<strong>{text}</strong>'
    if href:
      text = f'<a href="{html.escape(href)}" rel="nofollow noopener" target="_blank">{text}</a>'
    result += text
  return result


def inline_json(parts):
  nodes = []
  for text, bold, href in parts:
    if not text:
      continue
    node = {'type': 'text', 'text': text}
    marks = []
    if bold:
      marks.append({'type': 'bold'})
    if href:
      marks.append({'type': 'link', 'attrs': {'href': href, 'target': '_blank', 'rel': 'nofollow noopener'}})
    if marks:
      node['marks'] = marks
    nodes.append(node)
  return nodes


def json_paragraph(parts):
  node = {'type': 'paragraph', 'attrs': {'nodeIndent': None, 'nodeTextAlignment': None, 'nodeLineHeight': None, 'style': ''}}
  content = inline_json(parts)
  if content:
    node['content'] = content
  return node


def build_body(version, release_notes, release_url, use_lists):
  """Build the post body as HTML and as the Patreon editor (TipTap) document."""

  blocks = [('paragraph', [(f'Strawberry {version} is released.', False, None)])]
  blocks += parse_markdown(release_notes)
  blocks.append(('paragraph', [('Release on GitHub: ', False, None), (release_url, False, release_url)]))

  html_body = ''
  json_body = []
  for block in blocks:
    if block[0] == 'heading':
      html_body += f'<h{block[1]}>{inline_html(block[2])}</h{block[1]}>'
      json_body.append({'type': 'heading', 'attrs': {'level': block[1]}, 'content': inline_json(block[2])})
    elif block[0] == 'list' and use_lists:
      html_body += '<ul>' + ''.join(f'<li><p>{inline_html(item)}</p></li>' for item in block[1]) + '</ul>'
      json_body.append({'type': 'bulletList', 'content': [{'type': 'listItem', 'content': [json_paragraph(item)]} for item in block[1]]})
    elif block[0] == 'list':
      for item in block[1]:
        item = [('\u2022 ', False, None)] + item
        html_body += f'<p>{inline_html(item)}</p>'
        json_body.append(json_paragraph(item))
    else:
      html_body += f'<p>{inline_html(block[1])}</p>'
      json_body.append(json_paragraph(block[1]))

  return html_body, json_body


def relationship_ids(post, name):
  rel = post['data'].get('relationships', {}).get(name, {}).get('data') or []
  return [item['id'] for item in rel]


def build_post_data(previous, new_post_id, old_version, new_version, release_notes, release_url, access_rules, price_cents, publish, use_lists=True):

  prev_attributes = previous['data']['attributes']

  def replace_version(value):
    return re.sub(rf'(?<![\d.]){re.escape(old_version)}(?!\.?\d)', new_version, value) if isinstance(value, str) else value

  html_body, json_body = build_body(new_version, release_notes, release_url, use_lists)

  # Paywall line at the top of the post, with the unlock buttons shown there.
  json_body.insert(0, {
    'type': 'paywallBreakpoint',
    'attrs': {
      'paywallBreakpointCtaProps': {
        'currencyCode': 'USD',
        'isMonetized': True,
        'isPaidAccessSelected': True,
        'isPaidMembersSelected': bool(access_rules),
        'monetizationPriceCents': price_cents,
        'showCtas': True,
        'postId': new_post_id,
      },
    },
  })

  # Same settings as the Patreon editor sends for a product sold for price_cents, also unlocked by the paid tiers, with the unlock buttons at the paywall line (post_layout, product_layout is beside the post title).
  attributes = {
    'comments_write_access_level': 'all',
    'is_paid': False,
    'is_monetized': True,
    'price_cents': price_cents,
    'new_post_email_type': 'full_post',
    'paywall_display': 'post_layout',
    'post_type': 'text_only',
    'preview_asset_type': 'default',
    'thumbnail_position': None,
    'title': replace_version(prev_attributes['title']),
    'is_preview_blurred': True,
    'is_header_media_free': None,
    'allow_preview_in_rss': True,
    'post_metadata': {'platform': {}},
    'content': html_body,
    'content_json_string': json.dumps({'type': 'doc', 'content': json_body}),
    'teaser_text': replace_version(prev_attributes.get('teaser_text')),
    'tags': {'publish': publish},
  }

  tags = relationship_ids(previous, 'user_defined_tags')
  collections = relationship_ids(previous, 'collections')
  tag_values = {item['id']: item['attributes'].get('value') for item in previous.get('included', []) if item['type'] == 'post_tag'}

  relationships = {
    'user_defined_tags': {'data': [{'type': 'post_tag', 'id': tag} for tag in tags]},
    'access_rules': {'data': [{'type': 'access-rule', 'id': rule} for rule in access_rules]},
    'collections': {'data': [{'type': 'collection', 'id': collection} for collection in collections]},
  }
  if access_rules:
    relationships['access-rule'] = {'data': {'type': 'access-rule', 'id': access_rules[-1]}}
  if tags:
    relationships['post_tag'] = {'data': {'type': 'post_tag', 'id': tags[-1]}}

  included = [{'type': 'access-rule', 'id': rule, 'attributes': {}} for rule in access_rules]
  included += [{'type': 'post_tag', 'id': tag, 'attributes': {'value': tag_values.get(tag) or tag.split(';', 1)[-1], 'cardinality': 1}} for tag in tags]

  return {
    'data': {'type': 'post', 'attributes': attributes, 'relationships': relationships},
    'meta': {'auto_save': False, 'send_notifications': publish},
    'included': included,
  }


def post_url(post):
  # Use the same URL form as the website links: https://www.patreon.com/posts/<slug>
  url = post['attributes'].get('url') or post['attributes'].get('patreon_url') or f'/posts/{post["id"]}'
  return f'{BASE_URL}/posts/{url.rstrip("/").rsplit("/", 1)[-1]}'


def main():
  parser = argparse.ArgumentParser(description='Create a Strawberry release post on Patreon.')
  parser.add_argument('--previous-url', required=True, help='URL of the previous release post to use as template')
  parser.add_argument('--old-version', required=True)
  parser.add_argument('--new-version', required=True)
  parser.add_argument('--release-notes', required=True, help='File with the GitHub release notes (Markdown)')
  parser.add_argument('--release-url', required=True, help='URL of the GitHub release')
  parser.add_argument('--price-cents', type=int, default=2500, help='Product price in USD cents')
  parser.add_argument('--draft', action='store_true', help='Save the post as a draft instead of publishing it')
  parser.add_argument('--timeout-minutes', type=float, default=90, help='Give up and delete the unpublished post after this many minutes, keep it below the job timeout')
  parser.add_argument('files', nargs='+', help='Files to attach')
  args = parser.parse_args()

  cookie = os.environ.get('PATREON_COOKIE', '').strip()
  if not cookie:
    raise RuntimeError('PATREON_COOKIE is not set.')
  # Never include the cookie in the error, it's a secret.
  if not any(part.strip().startswith('session_id=') for part in cookie.split(';')):
    raise RuntimeError('PATREON_COOKIE has no session_id cookie, it should be session_id=<value>, not only the value.')

  for path in args.files:
    if not os.path.isfile(path):
      raise RuntimeError(f'Missing file: {path}')

  with open(args.release_notes, encoding='utf-8') as f:
    release_notes = f.read().strip()
  if not release_notes:
    raise RuntimeError('The GitHub release notes are empty.')

  m = re.search(r'(\d+)/?$', args.previous_url)
  if not m:
    raise RuntimeError(f'Could not find post ID in {args.previous_url}')

  patreon = Patreon(cookie, time.time() + args.timeout_minutes * 60)
  patreon.login()

  previous = patreon.get_post(m.group(1))
  if not previous['data']['attributes'].get('current_user_can_view'):
    raise RuntimeError('Previous post is not viewable, the Patreon session cookie is probably not for the creator account.')
  campaign_id = previous['data']['relationships']['campaign']['data']['id']
  access_rules = patreon.get_paid_tier_access_rules(campaign_id)

  title = re.sub(rf'(?<![\d.]){re.escape(args.old_version)}(?!\.?\d)', args.new_version, previous['data']['attributes']['title'])
  if title == previous['data']['attributes']['title']:
    raise RuntimeError(f'Previous post title "{title}" does not contain version {args.old_version}.')

  if not args.draft:
    existing = patreon.find_post_by_title(campaign_id, title, previous['data']['attributes'].get('published_at'))
    if existing:
      log(f'Post "{title}" already exists, not creating a new one.')
      print(post_url(existing))
      return

  new_post = patreon.create_post()
  new_post_id = new_post['data']['id']
  log(f'Created post {new_post_id}')

  def post_data(publish, use_lists):
    return build_post_data(previous, new_post_id, args.old_version, args.new_version, release_notes, args.release_url, access_rules, args.price_cents, publish, use_lists)

  publishing = False
  try:
    for path in args.files:
      patreon.upload_attachment(new_post_id, path)

    # Save as draft first and verify the product price before publishing.
    use_lists = True
    try:
      patreon.finalize_post(new_post_id, post_data(False, use_lists))
    except HTTPError as e:
      if e.status_code not in (400, 422):
        raise
      log(f'Patreon rejected the post ({e}), retrying without bullet lists.')
      use_lists = False
      patreon.finalize_post(new_post_id, post_data(False, use_lists))

    price_cents = patreon.get_post_price_cents(new_post_id)
    if price_cents != args.price_cents:
      raise RuntimeError(f'Post product price is {price_cents}, expected {args.price_cents}.')
    log(f'Product price: {price_cents / 100:.2f} USD')

    if not args.draft:
      publishing = True
      patreon.finalize_post(new_post_id, post_data(True, use_lists))
  except Exception:
    # Cleanup gets its own time, also when the deadline has passed.
    patreon.deadline = None
    # The publish request can fail after Patreon has published the post, never delete a post that may be published.
    delete = True
    if publishing:
      try:
        delete = not patreon.request('GET', f'/api/posts/{new_post_id}?fields[post]=published_at&{API_QUERY}')['data']['attributes'].get('published_at')
        if not delete:
          log(f'Post {new_post_id} was published despite the error, not deleting it.')
      except Exception as e:
        log(f'Could not check if post {new_post_id} was published, not deleting it: {e}')
        delete = False
    if delete:
      log(f'Failed, deleting post {new_post_id}')
      try:
        patreon.delete_post(new_post_id)
      except Exception as e:
        log(f'Failed to delete post {new_post_id}: {e}')
    raise

  post = patreon.request('GET', f'/api/posts/{new_post_id}?fields[post]=title,url,patreon_url,published_at&{API_QUERY}')['data']
  if not args.draft and not post['attributes'].get('published_at'):
    raise RuntimeError(f'Post {new_post_id} was created but is not published.')
  log(f'{"Saved draft" if args.draft else "Published"} "{post["attributes"].get("title")}"')
  print(post_url(post))


if __name__ == '__main__':
  try:
    main()
  except Exception as e:
    log(f'Error: {e}')
    sys.exit(1)
