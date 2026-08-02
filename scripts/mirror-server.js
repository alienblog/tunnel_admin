// 本地 HTTP 镜像：为 electron-builder 提供无符号链接的 winCodeSign 等二进制归档
// 用法：node mirror-server.js <root> <port>
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.argv[2] || 'C:/tunneladmin-build/mirror');
const port = Number(process.argv[3] || 8899);

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent((req.url || '/').replace(/^\//, ''));
  const file = path.resolve(path.join(root, rel));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
server.listen(port, '127.0.0.1', () => {
  console.log(`mirror: http://127.0.0.1:${port} (root=${root})`);
});
