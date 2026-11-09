import assert from "node:assert/strict";
import { test } from "node:test";
process.env.SERVER_AUTOLISTEN="0";
const product=await import("../src/server.ts");
test("product shutdown closes the actual listener and rejects subsequent connections",async()=>{
 const shutdown=(product as unknown as {shutdown?:()=>Promise<void>}).shutdown;
 assert.equal(typeof shutdown,"function","product must own its graceful shutdown boundary");
 await new Promise<void>(resolve=>product.server.listen(0,"127.0.0.1",resolve));
 const base=`http://127.0.0.1:${(product.server.address() as {port:number}).port}`;
 assert.equal((await fetch(base+'/healthz')).status,200);
 await shutdown!();assert.equal(product.server.listening,false);
 await assert.rejects(()=>fetch(base+'/healthz'));
});
