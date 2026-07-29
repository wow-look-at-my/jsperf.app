// @name Array.prototype.forEach
let sum = 0
items.forEach(item => {
  sum += item
})
if (sum !== expected) throw new Error('wrong sum')
