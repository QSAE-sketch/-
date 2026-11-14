var https = require('https');
var fs = require('fs');

var KEY = 'wbpk_al8DGujKMUoSkD3CtP5Rsa_KHdhhRdGEu50JsJS0HiN5EZqZyHt2iSf';
var SHARE = '?sharecode=QQKVVQEL2D';
var OUT = 'C:/Users/Administrator/Downloads/apk-site/index.html';
var API = '/.cloud/database/rest/apk_catalog?select=file_name,size_label,download_url,file_type,stored_name&enabled=eq.true&order=sort_order.asc';

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fetchCatalog(cb) {
  var req = https.request({
    host: 'apk-download-site.app.workbuddy.host',
    path: API,
    method: 'GET',
    headers: { 'x-wb-webapp-access-key': KEY }
  }, function (res) {
    var d = '';
    res.on('data', function (c) { d += c; });
    res.on('end', function () {
      try { cb(null, JSON.parse(d)); } catch (e) { cb(e); }
    });
  });
  req.on('error', cb);
  req.setTimeout(20000, function () { req.destroy(); cb(new Error('timeout')); });
  req.end();
}

fetchCatalog(function (err, rows) {
  if (err || !rows || !rows.length) {
    console.error('CATALOG_FAIL ' + (err ? err.message : 'empty'));
    process.exit(1);
  }

  var items = '';
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var stored = r.stored_name || r.file_name;
    var href = r.download_url || ('./files/' + encodeURIComponent(stored) + SHARE);
    var meta = (r.file_type || 'APK') + (r.size_label ? ' · ' + r.size_label : '');
    items += '  <li><div class="card"><div class="nm">' + esc(r.file_name) + ' <span class="sz">' + esc(meta) + '</span></div>'
          + '<a class="btn" href="' + esc(href) + '" download="' + esc(r.file_name) + '">下载</a></div></li>\n';
  }

  var html = [
'<!doctype html>',
'<html lang="zh-CN">',
'<head>',
'<meta charset="utf-8">',
'<meta name="viewport" content="width=device-width,initial-scale=1">',
'<link rel="icon" href="data:,">',
'<title>下载</title>',
'<style>',
'  body{margin:0;padding:8px;background:#ffffff;color:#000000;font:16px/1.5 Arial,sans-serif}',
'  h1{font-size:20px;margin:4px 0 8px}',
'  #note{font-size:14px;color:#333333;margin:0 0 10px}',
'  ul{list-style:none;margin:0;padding:0;overflow:hidden}',
'  li{float:left;width:100%}',
'  .card{margin:6px;border:1px solid #cccccc;padding:10px;background:#fafafa}',
'  .nm{font-size:15px;line-height:1.4;word-break:break-all;margin:0 0 8px;min-height:42px}',
'  .sz{color:#333333;font-size:13px}',
'  a.btn{display:block;width:120px;margin:0 auto;text-align:center;text-decoration:none;background:#ececec;color:#000000;border:1px solid #999999;font-size:16px;line-height:1.3;padding:10px 0}',
'  a.btn:visited{background:#ececec;color:#000000}',
'  a.btn:active{background:#d5d5d5;color:#000000}',
'  @media (min-width:700px){li{width:50%}}',
'  @media (min-width:1100px){li{width:33.3333%}}',
'  @media (min-width:1600px){li{width:25%}}',
'  @media (min-width:2200px){li{width:20%}}',
'</style>',
'</head>',
'<body>',
'<h1>选择要下载的东西</h1>',
'<p id="note">点下面的按钮下载，一次点一个。</p>',
'<ul id="list">',
items + '</ul>',
'<script>',
'(function () {',
'  var SHARE = window.location.search || "' + SHARE + '";',
'  var KEY = "' + KEY + '";',
'  function esc(s) {',
'    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\'/g, "&#39;");',
'  }',
'  var all = document.getElementsByTagName("a");',
'  for (var i = 0; i < all.length; i++) {',
'    var a = all[i];',
'    if (a.className !== "btn") continue;',
'    var h = a.getAttribute("href") || "";',
'    if (h.indexOf("./files/") === 0) a.setAttribute("href", h.split("?")[0] + SHARE);',
'  }',
'  function build(rows) {',
'    var html = "";',
'    for (var j = 0; j < rows.length; j++) {',
'      var r = rows[j];',
'      var src = r.u ? r.u : ("./files/" + encodeURIComponent(r.st || r.n) + SHARE);',
'      var meta = (r.t || "APK") + (r.s ? " · " + r.s : "");',
'      html += "<li><div class=\\"card\\"><div class=\\"nm\\">" + esc(r.n) + " <span class=\\"sz\\">" + esc(meta) + "</span></div>"',
'            + "<a class=\\"btn\\" href=\\"" + esc(src) + "\\" download=\\"" + esc(r.n) + "\\">下载</a></div></li>";',
'    }',
'    document.getElementById("list").innerHTML = html || "<li>清单为空</li>";',
'    document.getElementById("note").textContent = "共 " + rows.length + " 个，点按钮下载";',
'  }',
'  try {',
'    var xhr = new XMLHttpRequest();',
'    xhr.open("GET", "' + API + '", true);',
'    xhr.setRequestHeader("x-wb-webapp-access-key", KEY);',
'    xhr.onreadystatechange = function () {',
'      if (xhr.readyState !== 4 || xhr.status < 200 || xhr.status >= 300) return;',
'      try {',
'        var rows = JSON.parse(xhr.responseText);',
'        if (!rows || !rows.length) return;',
'        var out = [];',
'        for (var k = 0; k < rows.length; k++) {',
'          out.push({ n: rows[k].file_name, s: rows[k].size_label || "", u: rows[k].download_url || "", t: rows[k].file_type || "APK", st: rows[k].stored_name || "" });',
'        }',
'        build(out);',
'      } catch (e) { /* 保留静态列表 */ }',
'    };',
'    xhr.send();',
'  } catch (e) { /* 保留静态列表 */ }',
'})();',
'</script>',
'</body>',
'</html>',
''
  ].join('\n');

  fs.writeFileSync(OUT, html, 'utf8');
  console.log('GENERATED rows=' + rows.length + ' bytes=' + html.length);
});
