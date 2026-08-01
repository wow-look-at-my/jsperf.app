// @name Array.prototype.reduce
const sum = items.reduce((total, item) => total + item, 0)
if (sum !== expected) throw new Error('wrong sum')
