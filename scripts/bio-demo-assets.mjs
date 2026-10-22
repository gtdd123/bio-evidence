// Deterministic scientific UI fixtures. These are synthetic, not biological measurements.
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = resolve(root, 'apps/electron/src/renderer/bio/demo-assets');
mkdirSync(out, { recursive: true });
const offset = relative(realpathSync(root), realpathSync(out));
if (!offset || offset.startsWith('..') || isAbsolute(offset)) throw Error('Invalid demo asset directory');
const width = 256, height = 256, frames = 12, channels = 3, bytes = width * height * channels * 2, directorySize = 132;
const tiff = Buffer.alloc(8 + frames * (directorySize + bytes));
tiff.write('II'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
for (let frame = 0; frame < frames; frame++) {
  const base = 8 + frame * (directorySize + bytes), pixels = base + directorySize, bits = base + 126, preview = Buffer.alloc(width * height * channels);
  tiff.writeUInt16LE(10, base);
  const tags = [[256,4,1,width],[257,4,1,height],[258,3,3,bits],[259,3,1,1],[262,3,1,2],[273,4,1,pixels],[277,3,1,channels],[278,4,1,height],[279,4,1,bytes],[284,3,1,1]];
  tags.forEach(([tag,type,count,value], index) => { const entry = base + 2 + index * 12; tiff.writeUInt16LE(tag, entry); tiff.writeUInt16LE(type, entry+2); tiff.writeUInt32LE(count, entry+4); type===3 && count===1 ? tiff.writeUInt16LE(value,entry+8) : tiff.writeUInt32LE(value,entry+8); });
  tiff.writeUInt32LE(frame < frames-1 ? base+directorySize+bytes : 0,base+122);
  for (let c=0;c<3;c++) tiff.writeUInt16LE(16,bits+c*2);
  for (let y=0;y<height;y++) for (let x=0;x<width;x++) {
    const v = [0,0,0];
    for(let cell=0;cell<19;cell++) {
      const cx=20+(cell*73%219)+Math.sin(frame*.32+cell)*4, cy=18+(cell*47%221)+Math.cos(frame*.28+cell)*3;
      const dx=(x-cx)/(10+cell%5),dy=(y-cy)/(7+cell%4),r=Math.sqrt(dx*dx+dy*dy);
      v[1]+=Math.exp(-Math.pow((r-1)*5,2))*.72; v[2]+=Math.exp(-(dx*dx+dy*dy)*2)*.88; v[0]+=Math.exp(-Math.pow((r-.55)*8,2))*.24;
    }
    for(let c=0;c<3;c++){const i=(y*width+x)*3+c, value=Math.min(65535,Math.round((Math.min(1,v[c])+.003*(1+Math.sin(x*17+y*23+c)))*65000)); tiff.writeUInt16LE(value,pixels+i*2);preview[i]=Math.round(Math.sqrt(value/65535)*255);}
  }
  await sharp(preview,{raw:{width,height,channels}}).png().toFile(resolve(out,`confocal-${String(frame+1).padStart(2,'0')}.png`));
}
writeFileSync(resolve(out,'synthetic-confocal-stack.tiff'),tiff);
writeFileSync(resolve(out,'sequencing-qc-summary.json'),JSON.stringify({synthetic:true,purpose:'UI demonstration only',sampleId:'DEMO-QC-001',biologicalMeasurements:false,checks:['file integrity','preview metadata'],status:'illustrative'},null,2)+'\n');
console.log('Generated 12 deterministic RGB previews and one 12-frame RGB16 TIFF. Synthetic data only.');
