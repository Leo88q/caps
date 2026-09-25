import { createServer } from 'http';
import { readFileSync } from 'fs';
const html = readFileSync('/home/user/guttercaps/guttercaps-landing.html');
createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}).listen(8080, '0.0.0.0', () => console.log('landing on :8080'));
