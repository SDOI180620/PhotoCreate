export function testWav() {
  const rate=8000,samples=8000,bytes=Buffer.alloc(44+samples*2);
  bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVE',8);bytes.write('fmt ',12);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(samples*2,40);
  for(let i=0;i<samples;i++) bytes.writeInt16LE(Math.round(Math.sin(i*440*Math.PI*2/rate)*1000),44+i*2);
  return bytes;
}
