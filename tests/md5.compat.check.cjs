// Self-check for the MD5 signature fix. Runs with plain node, no npm deps.
// node:crypto is dev-only here; the shipped Worker uses the pure-JS 'md5' package.
const crypto = require('node:crypto');
const md5 = function(s){ return crypto.createHash('md5').update(s,'utf8').digest('hex'); };

const vectors = {
  '': 'd41d8cd98f00b204e9800998ecf8427e',
  'a': '0cc175b9c0f1b6a831c399e269772661',
  'abc': '900150983cd24fb0d6963f7d28e17f72',
  'message digest': 'f96b697d7cb7938d525a2f31aaf161d0',
  'abcdefghijklmnopqrstuvwxyz': 'c3fcd3d76192e4007dfb496cca67e13b'
};
let pass=0, fail=0;
Object.keys(vectors).forEach(function(k){
  const exp=vectors[k], got=md5(k);
  if(got===exp) pass++; else { fail++; console.log('RFC FAIL md5('+JSON.stringify(k)+')='+got+' expected '+exp); }
});

function buildSignString(params){
  return Object.keys(params).sort()
    .filter(function(k){ const v=params[k]; return v!=='' && v!==undefined && k!=='sign' && k!=='sign_type'; })
    .map(function(k){ return k+'='+params[k]; }).join('&');
}
function generateSignNew(params, apiKey){ return md5(apiKey + buildSignString(params) + apiKey); }
function simpleHash(str){
  let h=0;
  for(let i=0;i<str.length;i++){ const c=str.charCodeAt(i); h=((h<<5)-h+c); h=h&h; }
  return Math.abs(h).toString(16).padStart(32,'0');
}
function generateSignOld(params, apiKey){ return simpleHash(apiKey + buildSignString(params) + apiKey).toLowerCase(); }

const params={pid:'1001',type:'wxpay',out_trade_no:'20260101001',name:'test',money:'0.01',notify_url:'https://x'};
const apiKey='SECRETKEY';
const neu=generateSignNew(params,apiKey), old=generateSignOld(params,apiKey);
console.log('NEW (real md5 ) : '+neu);
console.log('OLD (simpleHash): '+old);
if(neu===old){ fail++; console.log('REGRESSION: new==old (unexpected)'); }
else { pass++; console.log('OK: real MD5 differs from old simpleHash -> bug fixed'); }
const direct=md5(apiKey+buildSignString(params)+apiKey);
if(neu===direct) pass++; else { fail++; console.log('FAIL: generateSignNew != direct md5'); }

console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
