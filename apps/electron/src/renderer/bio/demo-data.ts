// Public bibliographic metadata + one short attributed excerpt. All measurements and traces are demo fixtures.
export const demoPaper = { id: 'unet-2015', title: 'U-Net: Convolutional Networks for Biomedical Image Segmentation', authors: 'Olaf Ronneberger · Philipp Fischer · Thomas Brox', year: 2015, url: 'https://arxiv.org/abs/1505.04597', snapshotId: 'demo-unet-snapshot', blockId: 'abstract-1', page: 1 }
export const demoExcerpt = 'we present a network and training strategy that relies on the strong use of data augmentation to use the available annotated samples more efficiently.'
export const demoCitation = { snapshotId: demoPaper.snapshotId, blockId: demoPaper.blockId, start: 0, end: demoExcerpt.length, quote: demoExcerpt }
export function demoCitationMatches(citation: typeof demoCitation): boolean {
  return citation.snapshotId === demoPaper.snapshotId && citation.blockId === demoPaper.blockId && Number.isInteger(citation.start) && Number.isInteger(citation.end) && citation.start >= 0 && citation.end > citation.start && citation.end <= demoExcerpt.length && demoExcerpt.slice(citation.start, citation.end) === citation.quote
}
export const demoEvidence = [
  { id: 'E1', claim: '论文提出使用数据增强，提高已有标注样本的利用率。', kind: '原文事实', limitation: '该段落没有给出所有数据集的实验细节。' },
  { id: 'E2', claim: '开展具体生物医学应用时，仍需在目标数据集上单独评估。', kind: '研究推断', limitation: '不能用此演示代替实验评估与人工复核。' },
]
export const demoTrace = [
  { id: 'search', icon: '⌕', type: 'ToolCall: EuropePMC_Search', title: '公开文献检索候选', detail: '预置题录：U-Net（2015）。此演示不向 Europe PMC 发起请求。', duration: 380 },
  { id: 'snapshot', icon: '▤', type: 'Snapshot: DocumentParse', title: '公开原文节选与定位锚点', detail: '预置摘要节选 · PDF 第 1 页 · abstract-1 · UTF-16。非浏览器现场解析 PDF。', duration: 126 },
  { id: 'guard', icon: '♧', type: 'PreToolUse: PublicInputGuard', title: '公开输入清单策略展示', detail: '仅含公开文献节选；不读取真实目录、密钥或课题组数据库。', duration: 8 },
  { id: 'model', icon: '✦', type: 'ModelStream', title: '结构化证据与引用报告', detail: '预置 Revision #3 · 未发起模型调用 · 需要人工复核。', duration: 1420 },
]
