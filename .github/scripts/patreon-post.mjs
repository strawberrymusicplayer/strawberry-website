#!/usr/bin/env node
/*
 * Create a new Strawberry release post on Patreon.
 *
 * Node.js (20 or newer) version of patreon-post.py, with no dependencies.
 *
 * Patreon's public API (v2) can't create posts, so this uses the same internal API as the patreon.com web editor, authenticated with a browser session cookie (PATREON_COOKIE).
 * It is undocumented and may break when Patreon changes it.
 *
 * The post body is generated from the GitHub release notes (Markdown) with a link to the GitHub release.
 * The post is created as a shop product with a price, unlockable by purchase or by any paid tier.
 * Tags and collections are copied from the previous release post, and the given files are uploaded as attachments.
 *
 * Prints the new post URL on stdout.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const BASE_URL = 'https://www.patreon.com';
const API_QUERY = 'json-api-version=1.0&json-api-use-default-includes=false';
const GITHUB_REPO_URL = 'https://github.com/strawberrymusicplayer/strawberry';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
// Total time in milliseconds for each request, the bucket upload sends the whole file.
const REQUEST_TIMEOUT = 60 * 1000;
const UPLOAD_TIMEOUT = 30 * 60 * 1000;
// Pages of 20 posts searched for an existing post, before giving up.
const MAX_SEARCH_PAGES = 10;

function log(msg) {
  process.stderr.write(`${msg}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Why a login page had no CSRF token, without anything from the cookie.
function loginResult(urlPath, status, url, text, headers) {
  const hints = [];
  if (new URL(url).pathname.includes('/login')) {
    hints.push('redirected to login, the session cookie is expired or logged out');
  }
  if (headers.get('cf-mitigated') === 'challenge' || text.includes('Just a moment')) {
    hints.push('Cloudflare challenge');
  }
  return `${urlPath}: HTTP ${status}` + (hints.length > 0 ? `, ${hints.join(', ')}` : '');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class HTTPError extends Error {

  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }

}

class Patreon {

  constructor(cookie, deadline = null) {
    this.deadline = deadline;
    this.headers = {
      'User-Agent': USER_AGENT,
      'Cookie': cookie,
      'Accept': 'application/vnd.api+json',
    };
    this.csrf = null;
  }

  // Limit a timeout to the time left before the deadline.
  timeout(timeout) {
    if (this.deadline === null) {
      return AbortSignal.timeout(timeout);
    }
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) {
      throw new Error('Ran out of time, see --timeout-minutes.');
    }
    return AbortSignal.timeout(Math.min(timeout, remaining));
  }

  async login() {
    const results = [];
    for (const urlPath of ['/home', '/membership']) {
      const r = await fetch(BASE_URL + urlPath, { headers: { ...this.headers, 'Accept': 'text/html' }, signal: this.timeout(REQUEST_TIMEOUT) });
      const text = await r.text();
      // A logged out session ends at the login page, which has a CSRF token too.
      if (new URL(r.url).pathname.includes('/login')) {
        results.push(loginResult(urlPath, r.status, r.url, text, r.headers));
        continue;
      }
      for (const pattern of [/<meta name="csrf-token" content="([^"]+)"/, /"csrfSignature"\s*:\s*"([^"]+)"/]) {
        const m = text.match(pattern);
        if (m) {
          this.csrf = m[1];
          this.headers['X-CSRF-Signature'] = this.csrf;
          return;
        }
      }
      results.push(loginResult(urlPath, r.status, r.url, text, r.headers));
    }
    throw new Error(`Could not find CSRF token (${results.join('; ')}).`);
  }

  async request(method, url, { json, timeout = REQUEST_TIMEOUT } = {}) {
    if (!url.startsWith('http')) {
      url = BASE_URL + url;
    }
    const options = { method, headers: { ...this.headers }, signal: this.timeout(timeout) };
    if (json !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(json);
    }
    const r = await fetch(url, options);
    const text = await r.text();
    if (r.status >= 400) {
      throw new HTTPError(r.status, `${method} ${url} failed with HTTP ${r.status}: ${text.slice(0, 2000)}`);
    }
    return text ? JSON.parse(text) : null;
  }

  getPost(postId) {
    return this.request('GET', `/api/posts/${postId}?include=campaign,access_rules,user_defined_tags,collections&${API_QUERY}`);
  }

  // Search the published posts newest first, a post with the title can't be older than since (the previous release post).
  async findPostByTitle(campaignId, title, since = null) {
    const sinceTime = since ? Date.parse(since) : NaN;
    let cursor = null;
    for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
      let url = `/api/posts?filter[campaign_id]=${campaignId}&filter[contains_exclusive_posts]=true&filter[is_draft]=false&sort=-published_at&fields[post]=title,url,published_at&page[count]=20&${API_QUERY}`;
      if (cursor) {
        url += `&page[cursor]=${encodeURIComponent(cursor)}`;
      }
      const posts = await this.request('GET', url);
      for (const post of posts.data) {
        if (post.attributes.title === title) {
          return post;
        }
        const publishedTime = post.attributes.published_at ? Date.parse(post.attributes.published_at) : NaN;
        if (publishedTime < sinceTime) {
          return null;
        }
      }
      cursor = posts.meta?.pagination?.cursors?.next;
      if (!cursor || posts.data.length === 0) {
        return null;
      }
    }
    throw new Error(`Searched ${MAX_SEARCH_PAGES} pages of posts without reaching the previous release post, not creating a possible duplicate.`);
  }

  async getPaidTierAccessRules(campaignId) {
    const campaign = await this.request('GET', `/api/campaigns/${campaignId}?include=access_rules.tier.null&fields[access-rule]=access_rule_type,amount_cents&fields[reward]=title,amount_cents,published,is_free_tier&${API_QUERY}`);
    const included = campaign.included || [];
    const tiers = new Map(included.filter((item) => item.type === 'reward').map((item) => [item.id, item.attributes]));
    const rules = [];
    for (const item of included) {
      if (item.type !== 'access-rule' || item.attributes.access_rule_type !== 'tier') {
        continue;
      }
      const tier = tiers.get(item.relationships?.tier?.data?.id);
      if (tier && (tier.amount_cents || 0) > 0 && !tier.is_free_tier && (tier.published ?? true)) {
        log(`Paid tier: ${tier.title} (${(tier.amount_cents / 100).toFixed(2)}), access rule ${item.id}`);
        rules.push(item.id);
      }
    }
    if (rules.length === 0) {
      throw new Error('Found no paid tiers in the campaign.');
    }
    return rules.sort((a, b) => Number(a) - Number(b));
  }

  createPost() {
    // Created from the shop as a product.
    const data = { data: { type: 'post', attributes: { post_type: 'text_only', purchase_only: true } } };
    return this.request('POST', `/api/posts?fields[post]=post_type,post_metadata&include=drop&${API_QUERY}`, { json: data });
  }

  async deletePost(postId) {
    await this.request('DELETE', `/api/posts/${postId}?${API_QUERY}`);
  }

  async uploadAttachment(postId, filePath) {
    const fileName = path.basename(filePath);
    const size = fs.statSync(filePath).size;
    log(`Uploading ${fileName} (${size} bytes)`);
    const data = {
      data: {
        type: 'media',
        attributes: {
          state: 'pending_upload',
          file_name: fileName,
          size_bytes: size,
          owner_id: postId,
          owner_type: 'post',
          owner_relationship: 'attachment',
        },
      },
    };
    const media = (await this.request('POST', `/api/media?include=[]&${API_QUERY}`, { json: data })).data;
    const attributes = media.attributes;

    // Upload to the storage bucket using the pre-signed form fields.
    const form = new FormData();
    for (const [key, value] of Object.entries(attributes.upload_parameters)) {
      form.append(key, String(value));
    }
    form.append('file', await fs.openAsBlob(filePath), fileName);
    const r = await fetch(attributes.upload_url, { method: 'POST', body: form, headers: { 'User-Agent': USER_AGENT }, signal: this.timeout(UPLOAD_TIMEOUT) });
    if (r.status >= 400) {
      throw new Error(`Uploading ${fileName} to bucket failed with HTTP ${r.status}: ${(await r.text()).slice(0, 2000)}`);
    }

    const timeout = Date.now() + 900 * 1000;
    while (Date.now() < timeout) {
      const state = (await this.request('GET', `/api/media/${media.id}?include=[]&${API_QUERY}`)).data.attributes.state;
      if (state === 'ready') {
        return media.id;
      }
      if (state === 'failed') {
        throw new Error(`Patreon failed processing ${fileName}`);
      }
      await sleep(5000);
    }
    throw new Error(`Timeout waiting for Patreon to process ${fileName}`);
  }

  async finalizePost(postId, data) {
    await this.request('PATCH', `/api/posts/${postId}?include=[]&${API_QUERY}`, { json: data });
  }

  async getPostPriceCents(postId) {
    const post = await this.request('GET', `/api/posts/${postId}?include=content_unlock_options.product_variant.null&fields[post]=is_monetized,paywall_display&fields[content-unlock-option]=content_unlock_type&fields[product-variant]=price_cents,currency_code&${API_QUERY}`);
    for (const item of post.included || []) {
      if (item.type === 'product-variant') {
        return item.attributes.price_cents ?? null;
      }
    }
    return null;
  }

}

const INLINE_RE = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*(.+?)\*\*|`([^`]+)`|(https?:\/\/[^\s)]+)|(?<![\w&])#(\d+)\b/g;

// Parse Markdown inline text into a list of [text, bold, href].
export function parseInline(text) {
  const parts = [];
  let pos = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    if (m.index > pos) {
      parts.push([text.slice(pos, m.index), false, null]);
    }
    const [, linkText, linkUrl, bold, code, url, issue] = m;
    if (linkText) {
      // Only link to web pages, other schemes like javascript: are kept as plain text.
      parts.push([linkText, false, /^https?:\/\//i.test(linkUrl) ? linkUrl : null]);
    }
    else if (bold) {
      parts.push([bold, true, null]);
    }
    else if (code) {
      parts.push([code, false, null]);
    }
    else if (url) {
      parts.push([url, false, url]);
    }
    else {
      parts.push([`#${issue}`, false, `${GITHUB_REPO_URL}/issues/${issue}`]);
    }
    pos = m.index + m[0].length;
  }
  if (pos < text.length) {
    parts.push([text.slice(pos), false, null]);
  }
  return parts;
}

// Parse the GitHub release notes into blocks: ['heading', level, inline], ['list', [inline]] or ['paragraph', inline].
export function parseMarkdown(markdown) {
  const blocks = [];
  for (let line of markdown.replaceAll('\r\n', '\n').split('\n')) {
    line = line.trimEnd();
    const last = blocks[blocks.length - 1];
    if (!line.trim()) {
      if (last && last[0] === 'paragraph') {
        blocks.push(['break']);
      }
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    const item = line.match(/^\s*[-*+]\s+(.*)$/);
    if (heading) {
      blocks.push(['heading', Math.min(heading[1].length, 3), parseInline(heading[2].trim())]);
    }
    else if (item) {
      if (last && last[0] === 'list') {
        last[1].push(parseInline(item[1].trim()));
      }
      else {
        blocks.push(['list', [parseInline(item[1].trim())]]);
      }
    }
    else if (last && last[0] === 'paragraph') {
      last[1].push([' ', false, null], ...parseInline(line.trim()));
    }
    else if (last && last[0] === 'list' && (line.startsWith(' ') || line.startsWith('\t'))) {
      last[1][last[1].length - 1].push([' ', false, null], ...parseInline(line.trim()));
    }
    else {
      blocks.push(['paragraph', parseInline(line.trim())]);
    }
  }
  return blocks.filter((block) => block[0] !== 'break');
}

function escapeHtml(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll('\'', '&#x27;');
}

function inlineHtml(parts) {
  let result = '';
  for (const [rawText, bold, href] of parts) {
    let text = escapeHtml(rawText);
    if (bold) {
      text = `<strong>${text}</strong>`;
    }
    if (href) {
      text = `<a href="${escapeHtml(href)}" rel="nofollow noopener" target="_blank">${text}</a>`;
    }
    result += text;
  }
  return result;
}

function inlineJson(parts) {
  const nodes = [];
  for (const [text, bold, href] of parts) {
    if (!text) {
      continue;
    }
    const node = { type: 'text', text };
    const marks = [];
    if (bold) {
      marks.push({ type: 'bold' });
    }
    if (href) {
      marks.push({ type: 'link', attrs: { href, target: '_blank', rel: 'nofollow noopener' } });
    }
    if (marks.length > 0) {
      node.marks = marks;
    }
    nodes.push(node);
  }
  return nodes;
}

function jsonParagraph(parts) {
  const node = { type: 'paragraph', attrs: { nodeIndent: null, nodeTextAlignment: null, nodeLineHeight: null, style: '' } };
  const content = inlineJson(parts);
  if (content.length > 0) {
    node.content = content;
  }
  return node;
}

// Build the post body as HTML and as the Patreon editor (TipTap) document.
export function buildBody(version, releaseNotes, releaseUrl, useLists) {
  const blocks = [['paragraph', [[`Strawberry ${version} is released.`, false, null]]]];
  blocks.push(...parseMarkdown(releaseNotes));
  blocks.push(['paragraph', [['Release on GitHub: ', false, null], [releaseUrl, false, releaseUrl]]]);

  let htmlBody = '';
  const jsonBody = [];
  for (const block of blocks) {
    if (block[0] === 'heading') {
      htmlBody += `<h${block[1]}>${inlineHtml(block[2])}</h${block[1]}>`;
      jsonBody.push({ type: 'heading', attrs: { level: block[1] }, content: inlineJson(block[2]) });
    }
    else if (block[0] === 'list' && useLists) {
      htmlBody += '<ul>' + block[1].map((item) => `<li><p>${inlineHtml(item)}</p></li>`).join('') + '</ul>';
      jsonBody.push({ type: 'bulletList', content: block[1].map((item) => ({ type: 'listItem', content: [jsonParagraph(item)] })) });
    }
    else if (block[0] === 'list') {
      for (let item of block[1]) {
        item = [['• ', false, null], ...item];
        htmlBody += `<p>${inlineHtml(item)}</p>`;
        jsonBody.push(jsonParagraph(item));
      }
    }
    else {
      htmlBody += `<p>${inlineHtml(block[1])}</p>`;
      jsonBody.push(jsonParagraph(block[1]));
    }
  }

  return [htmlBody, jsonBody];
}

function relationshipIds(post, name) {
  const rel = post.data.relationships?.[name]?.data || [];
  return rel.map((item) => item.id);
}

function replaceVersion(value, oldVersion, newVersion) {
  return typeof value === 'string' ? value.replace(new RegExp(`(?<![\\d.])${escapeRegExp(oldVersion)}(?!\\.?\\d)`, 'g'), newVersion) : value;
}

export function buildPostData(previous, newPostId, oldVersion, newVersion, releaseNotes, releaseUrl, accessRules, priceCents, publish, useLists = true) {

  const prevAttributes = previous.data.attributes;

  const [htmlBody, jsonBody] = buildBody(newVersion, releaseNotes, releaseUrl, useLists);

  // Paywall line at the top of the post, with the unlock buttons shown there.
  jsonBody.unshift({
    type: 'paywallBreakpoint',
    attrs: {
      paywallBreakpointCtaProps: {
        currencyCode: 'USD',
        isMonetized: true,
        isPaidAccessSelected: true,
        isPaidMembersSelected: accessRules.length > 0,
        monetizationPriceCents: priceCents,
        showCtas: true,
        postId: newPostId,
      },
    },
  });

  // Same settings as the Patreon editor sends for a product sold for priceCents, also unlocked by the paid tiers, with the unlock buttons at the paywall line (post_layout, product_layout is beside the post title).
  const attributes = {
    comments_write_access_level: 'all',
    is_paid: false,
    is_monetized: true,
    price_cents: priceCents,
    new_post_email_type: 'full_post',
    paywall_display: 'post_layout',
    post_type: 'text_only',
    preview_asset_type: 'default',
    thumbnail_position: null,
    title: replaceVersion(prevAttributes.title, oldVersion, newVersion),
    is_preview_blurred: true,
    is_header_media_free: null,
    allow_preview_in_rss: true,
    post_metadata: { platform: {} },
    content: htmlBody,
    content_json_string: JSON.stringify({ type: 'doc', content: jsonBody }),
    teaser_text: replaceVersion(prevAttributes.teaser_text ?? null, oldVersion, newVersion),
    tags: { publish },
  };

  const tags = relationshipIds(previous, 'user_defined_tags');
  const collections = relationshipIds(previous, 'collections');
  const tagValues = new Map((previous.included || []).filter((item) => item.type === 'post_tag').map((item) => [item.id, item.attributes.value]));

  const relationships = {
    user_defined_tags: { data: tags.map((tag) => ({ type: 'post_tag', id: tag })) },
    access_rules: { data: accessRules.map((rule) => ({ type: 'access-rule', id: rule })) },
    collections: { data: collections.map((collection) => ({ type: 'collection', id: collection })) },
  };
  if (accessRules.length > 0) {
    relationships['access-rule'] = { data: { type: 'access-rule', id: accessRules[accessRules.length - 1] } };
  }
  if (tags.length > 0) {
    relationships.post_tag = { data: { type: 'post_tag', id: tags[tags.length - 1] } };
  }

  const included = accessRules.map((rule) => ({ type: 'access-rule', id: rule, attributes: {} }));
  included.push(...tags.map((tag) => ({ type: 'post_tag', id: tag, attributes: { value: tagValues.get(tag) || tag.slice(tag.indexOf(';') + 1), cardinality: 1 } })));

  return {
    data: { type: 'post', attributes, relationships },
    meta: { auto_save: false, send_notifications: publish },
    included,
  };
}

function postUrl(post) {
  // Use the same URL form as the website links: https://www.patreon.com/posts/<slug>
  const url = post.attributes.url || post.attributes.patreon_url || `/posts/${post.id}`;
  return `${BASE_URL}/posts/${url.replace(/\/+$/, '').split('/').pop()}`;
}

const USAGE = 'Usage: patreon-post.mjs --previous-url URL --old-version VERSION --new-version VERSION --release-notes FILE --release-url URL [--price-cents CENTS] [--timeout-minutes MINUTES] [--draft] FILE...';

function parseArguments() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'previous-url': { type: 'string' },
      'old-version': { type: 'string' },
      'new-version': { type: 'string' },
      'release-notes': { type: 'string' },
      'release-url': { type: 'string' },
      'price-cents': { type: 'string', default: '2500' },
      'timeout-minutes': { type: 'string', default: '90' },
      'draft': { type: 'boolean', default: false },
      'help': { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  for (const name of ['previous-url', 'old-version', 'new-version', 'release-notes', 'release-url']) {
    if (!values[name]) {
      throw new Error(`Missing --${name}\n${USAGE}`);
    }
  }
  if (!/^\d+$/.test(values['price-cents'])) {
    throw new Error(`Invalid --price-cents: ${values['price-cents']}`);
  }
  if (!/^\d+(\.\d+)?$/.test(values['timeout-minutes']) || Number(values['timeout-minutes']) <= 0) {
    throw new Error(`Invalid --timeout-minutes: ${values['timeout-minutes']}`);
  }
  if (positionals.length === 0) {
    throw new Error(`No files to attach\n${USAGE}`);
  }
  return {
    previousUrl: values['previous-url'],
    oldVersion: values['old-version'],
    newVersion: values['new-version'],
    releaseNotes: values['release-notes'],
    releaseUrl: values['release-url'],
    priceCents: Number(values['price-cents']),
    // Give up and delete the unpublished post after this many minutes, keep it below the job timeout.
    timeoutMinutes: Number(values['timeout-minutes']),
    draft: values.draft,
    files: positionals,
  };
}

async function main() {
  const args = parseArguments();

  const cookie = (process.env.PATREON_COOKIE || '').trim();
  if (!cookie) {
    throw new Error('PATREON_COOKIE is not set.');
  }
  // Never include the cookie in the error, it's a secret.
  if (!cookie.split(';').some((part) => part.trim().startsWith('session_id='))) {
    throw new Error('PATREON_COOKIE has no session_id cookie, it should be session_id=<value>, not only the value.');
  }

  for (const filePath of args.files) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new Error(`Missing file: ${filePath}`);
    }
  }

  const releaseNotes = fs.readFileSync(args.releaseNotes, 'utf-8').trim();
  if (!releaseNotes) {
    throw new Error('The GitHub release notes are empty.');
  }

  const m = args.previousUrl.match(/(\d+)\/?$/);
  if (!m) {
    throw new Error(`Could not find post ID in ${args.previousUrl}`);
  }

  const patreon = new Patreon(cookie, Date.now() + args.timeoutMinutes * 60 * 1000);
  await patreon.login();

  const previous = await patreon.getPost(m[1]);
  if (!previous.data.attributes.current_user_can_view) {
    throw new Error('Previous post is not viewable, the Patreon session cookie is probably not for the creator account.');
  }
  const campaignId = previous.data.relationships.campaign.data.id;
  const accessRules = await patreon.getPaidTierAccessRules(campaignId);

  const title = replaceVersion(previous.data.attributes.title, args.oldVersion, args.newVersion);
  if (title === previous.data.attributes.title) {
    throw new Error(`Previous post title "${title}" does not contain version ${args.oldVersion}.`);
  }

  if (!args.draft) {
    const existing = await patreon.findPostByTitle(campaignId, title, previous.data.attributes.published_at);
    if (existing) {
      log(`Post "${title}" already exists, not creating a new one.`);
      console.log(postUrl(existing));
      return;
    }
  }

  const newPost = await patreon.createPost();
  const newPostId = newPost.data.id;
  log(`Created post ${newPostId}`);

  const postData = (publish, useLists) => buildPostData(previous, newPostId, args.oldVersion, args.newVersion, releaseNotes, args.releaseUrl, accessRules, args.priceCents, publish, useLists);

  let publishing = false;
  try {
    for (const filePath of args.files) {
      await patreon.uploadAttachment(newPostId, filePath);
    }

    // Save as draft first and verify the product price before publishing.
    let useLists = true;
    try {
      await patreon.finalizePost(newPostId, postData(false, useLists));
    }
    catch (e) {
      if (!(e instanceof HTTPError) || ![400, 422].includes(e.statusCode)) {
        throw e;
      }
      log(`Patreon rejected the post (${e.message}), retrying without bullet lists.`);
      useLists = false;
      await patreon.finalizePost(newPostId, postData(false, useLists));
    }

    const priceCents = await patreon.getPostPriceCents(newPostId);
    if (priceCents !== args.priceCents) {
      throw new Error(`Post product price is ${priceCents}, expected ${args.priceCents}.`);
    }
    log(`Product price: ${(priceCents / 100).toFixed(2)} USD`);

    if (!args.draft) {
      publishing = true;
      await patreon.finalizePost(newPostId, postData(true, useLists));
    }
  }
  catch (e) {
    // Cleanup gets its own time, also when the deadline has passed.
    patreon.deadline = null;
    // The publish request can fail after Patreon has published the post, never delete a post that may be published.
    let remove = true;
    if (publishing) {
      try {
        remove = !(await patreon.request('GET', `/api/posts/${newPostId}?fields[post]=published_at&${API_QUERY}`)).data.attributes.published_at;
        if (!remove) {
          log(`Post ${newPostId} was published despite the error, not deleting it.`);
        }
      }
      catch (e2) {
        log(`Could not check if post ${newPostId} was published, not deleting it: ${e2.message}`);
        remove = false;
      }
    }
    if (remove) {
      log(`Failed, deleting post ${newPostId}`);
      try {
        await patreon.deletePost(newPostId);
      }
      catch (e2) {
        log(`Failed to delete post ${newPostId}: ${e2.message}`);
      }
    }
    throw e;
  }

  const post = (await patreon.request('GET', `/api/posts/${newPostId}?fields[post]=title,url,patreon_url,published_at&${API_QUERY}`)).data;
  if (!args.draft && !post.attributes.published_at) {
    throw new Error(`Post ${newPostId} was created but is not published.`);
  }
  log(`${args.draft ? 'Saved draft' : 'Published'} "${post.attributes.title}"`);
  console.log(postUrl(post));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    log(`Error: ${e.message}`);
    process.exit(1);
  });
}
