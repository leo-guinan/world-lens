import assert from "node:assert/strict";
import { test } from "node:test";
import { connect } from "node:net";
process.env.SERVER_AUTOLISTEN='0';
const product=await import('../src/server.ts');
test('product shutdown deadline drops a partial HTTP body and reports incomplete drain',async()=>{
 await new Promise<void>(resolve=>product.server.listen(0,'127.0.0.1',resolve));
 const port=(product.server.address() as {port:number}).port;
 const socket=connect(port,'127.0.0.1');socket.on('error',()=>{});
 await new Promise<void>(resolve=>socket.once('connect',resolve));
 const received=new Promise<void>(resolve=>product.server.once('request',()=>resolve()));
 socket.write(`POST /api/lens/sessions HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 1000\r\n\r\n{`);await received;
 try{
  const shutdown=product.shutdown as unknown as (options?:{deadlineMs:number})=>Promise<void>;
  const outcome=await Promise.race([shutdown({deadlineMs:30}).then(()=> 'closed',error=>String(error)),new Promise<string>(resolve=>setTimeout(()=>resolve('watchdog'),250))]);
  assert.match(outcome,/deadline|timed out/i);assert.equal(product.server.listening,false);
  socket.resume(); // Drain any buffered response so the client can observe FIN/close.
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('client socket did not close after deadline')),500);socket.once('close',()=>{clearTimeout(timer);resolve()});if(socket.destroyed){clearTimeout(timer);resolve()}});
 }finally{socket.destroy();product.server.closeAllConnections()}
});
