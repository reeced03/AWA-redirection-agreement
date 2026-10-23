// Show the AWA logo if available: /logo.png in this site first, then the logo on awainsurance.com,
// otherwise keep the text wordmark.
(function () {
  var sources = ['/logo.png', 'https://awainsurance.com/wp-content/themes/child-themes/awainsurancecom/img/logo-dark.png'];
  document.querySelectorAll('img[data-logo]').forEach(function (img) {
    var i = 0;
    var word = img.parentElement.querySelector('[data-wordmark]');
    function next() {
      if (i >= sources.length) return;
      img.src = sources[i++];
    }
    img.addEventListener('load', function () {
      if (img.naturalWidth > 1) { img.hidden = false; if (word) word.hidden = true; }
    });
    img.addEventListener('error', next);
    next();
  });
})();
