$(function(){
    $('.owl-carousel').owlCarousel({
        loop:true,
        autoplay:true,
        lazyLoad:true,
        margin:10,
        navText: [$('<i class="fas fa-chevron-left"></i>'),$('<i class="fas fa-chevron-right"></i>')],
        responsiveClass:true,
        responsive:{
            0:{
                items:1,
                nav:false
            },
            576:{
                items:2,
                nav:false
            },

            768:{
                items:3,
                nav:true
            },
            992:{
                items:4,
                nav:true,
                
            }
        }
    })
  });
