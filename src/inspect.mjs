/** Read-only live inspection; contains no writes or generation calls. */
import {Gateway} from './gateway.mjs';
import {Engine} from './engine.mjs';
if(!process.env.ASTRBOT_DATA)throw Error('ASTRBOT_DATA_REQUIRED');
const engine=new Engine({gateway:new Gateway(process.env.ASTRBOT_DATA),backup:async()=>{throw Error('READ_ONLY');}});
console.log(JSON.stringify(await engine.snapshot(),null,2));
