// @name for...of
let sum = 0
for (const item of items) {
  sum += item
}
if (sum !== expected) throw new Error('wrong sum')
