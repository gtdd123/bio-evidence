import React, { useState } from 'react'
import './demo.css'
const frames = [
  new URL('./demo-assets/confocal-01.png', import.meta.url).href, new URL('./demo-assets/confocal-02.png', import.meta.url).href,
  new URL('./demo-assets/confocal-03.png', import.meta.url).href, new URL('./demo-assets/confocal-04.png', import.meta.url).href,
  new URL('./demo-assets/confocal-05.png', import.meta.url).href, new URL('./demo-assets/confocal-06.png', import.meta.url).href,
  new URL('./demo-assets/confocal-07.png', import.meta.url).href, new URL('./demo-assets/confocal-08.png', import.meta.url).href,
  new URL('./demo-assets/confocal-09.png', import.meta.url).href, new URL('./demo-assets/confocal-10.png', import.meta.url).href,
  new URL('./demo-assets/confocal-11.png', import.meta.url).href, new URL('./demo-assets/confocal-12.png', import.meta.url).href,
]
const files = ['synthetic-confocal-stack.tiff', 'synthetic-assay-overlay.png', 'sequencing-qc-summary.json']
export function DemoLabMaterials() {
  const [file, setFile] = useState(files[0]!), [frame, setFrame] = useState(3), [zoom, setZoom] = useState(1), [note, setNote] = useState(''), [notes, setNotes] = useState(['示例批注 01 · 第 3 帧：对比核区域与细胞轮廓的预览效果。', '示例批注 02 · 图像由确定性程序合成，不代表真实细胞或实验结果。'])
  const image = file.endsWith('.tiff') ? frames[frame - 1] : frames[6]
  return <section className="bio-demo-materials"><div className="bio-section-title"><div><p className="bio-eyebrow">DEMO LAB MATERIALS</p><h3>示例实验图像与资料库</h3></div><span className="bio-demo-label">SYNTHETIC · 只读样例</span></div><p className="bio-muted">公开展示用合成数据。浏览和批注仅保存在当前页面内；没有创建真实资料授权或连接实验目录。</p>
    <div className="bio-demo-material-grid"><aside className="bio-demo-file-tree"><span className="bio-eyebrow">FILES / 03</span><p className="bio-demo-folder">▾ confocal-imaging-demo/</p>{files.map(name => <button key={name} type="button" aria-pressed={file === name} onClick={() => { setFile(name); setZoom(1) }}>{name.endsWith('.json') ? '▧' : '▣'} <span>{name}</span></button>)}<div className="bio-demo-file-meta"><strong>资料边界</strong><p>Read-only sample</p><p>Restricted 工作流演示</p><p>不访问外部磁盘</p></div></aside>
    <section className="bio-demo-viewer"><div className="bio-demo-image-toolbar"><strong>{file.endsWith('.json') ? 'JSON PREVIEW' : `Frame ${frame} / 12`}</strong>{!file.endsWith('.json') && <><label>帧 <input aria-label="示例图像帧" type="number" min={1} max={12} value={frame} onChange={event => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 1 && value <= 12) setFrame(value) }} /></label><label>缩放 <select aria-label="示例图像缩放" value={zoom} onChange={event => setZoom(Number(event.target.value))}><option value={1}>100%</option><option value={1.5}>150%</option><option value={2}>200%</option></select></label></>}</div>
    {file.endsWith('.json') ? <pre className="bio-demo-json">{JSON.stringify({ synthetic: true, sampleId: 'DEMO-QC-001', biologicalMeasurements: false, purpose: 'UI demonstration only', checks: ['file integrity', 'preview metadata'] }, null, 2)}</pre> : <div className="bio-demo-image-canvas"><img src={image} alt={`合成荧光图像 · 第 ${frame} / 12 帧`} style={{ transform: `scale(${zoom})` }} /><span className="bio-demo-image-watermark">SYNTHETIC / READ-ONLY</span><span className="bio-demo-scale">━━ 256 × 256 px</span></div>}
    <div className="bio-demo-image-footer"><span>16-bit synthetic TIFF source · RGB8 preview</span><span>Blue / Green / Red</span></div></section>
    <aside className="bio-demo-annotations"><span className="bio-eyebrow">MATERIAL ANNOTATIONS</span><h4>实验批注 <span>{notes.length}</span></h4>{notes.map((value, index) => <article key={index}><span>DEMO RESEARCHER · {String(index + 1).padStart(2, '0')}</span><p>{value}</p></article>)}<label className="bio-field"><span>添加演示批注</span><textarea aria-label="演示批注" maxLength={1000} value={note} onChange={event => setNote(event.target.value)} /></label><button className="bio-demo-primary" type="button" disabled={!note.trim() || notes.length >= 10} onClick={() => { setNotes(values => [...values, note.trim()]); setNote('') }}>保存至本次页面</button></aside></div>
  </section>
}
