import { expect, test } from 'bun:test'
import { assertBioWindowSender } from './bio-window-access'
test('Bio IPC accepts only its own product main frame and refuses another window, subframe or navigated page', () => {
  const frame = {}, contents = { id: 1, isDestroyed: () => false, getURL: () => 'file:///owned/bio.html', mainFrame: frame }
  const owner = { isDestroyed: () => false, webContents: contents }
  expect(() => assertBioWindowSender(owner, { sender: contents, senderFrame: frame }, contents.getURL())).not.toThrow()
  for (const event of [{ sender: { ...contents, id: 2 }, senderFrame: frame }, { sender: contents, senderFrame: {} }, { sender: contents, senderFrame: null }]) {
    expect(() => assertBioWindowSender(owner, event, contents.getURL())).toThrow('Research access denied.')
  }
  expect(() => assertBioWindowSender(owner, { sender: contents, senderFrame: frame }, 'file:///other/bio.html')).toThrow()
  expect(() => assertBioWindowSender(undefined, { sender: contents, senderFrame: frame }, contents.getURL())).toThrow()
})
