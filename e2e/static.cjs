const http = require('http'), fs = require('fs'), path = require('path');
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.ttf': 'font/ttf', '.ico': 'image/x-icon', '.json': 'application/json' };
for (const [root, port] of [['/tmp/web-student', 8081], ['/tmp/web-institute', 8082], ['/tmp/web-developer', 8083]].filter(([r]) => fs.existsSync(r)))
  http.createServer((req, res) => {
    let p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
    if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(root, 'index.html');
    res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
  }).listen(port, () => console.log('static', root, port));
