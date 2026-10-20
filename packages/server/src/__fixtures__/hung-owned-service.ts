// Explicit negative supervisor fixture: no database, tools, or real workers.
console.log('BioEvidence account service: synthetic-hung-child')
process.stdin.resume()
setInterval(() => {}, 1000)
// Beyond the 18s acceptance deadline: safety cleanup can never satisfy the test.
setTimeout(() => process.exit(2), 30000).unref()
