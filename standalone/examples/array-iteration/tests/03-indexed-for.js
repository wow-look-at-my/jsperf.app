// @name indexed for
let sum = 0
for (let i = 0; i < items.length; i += 1) {
  sum += items[i]
}
if (sum !== expected) throw new Error('wrong sum')
