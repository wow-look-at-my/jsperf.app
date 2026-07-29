const items = new Array(10000)
for (let i = 0; i < items.length; i += 1) {
  items[i] = i
}

// Every test checks its result against this. Not ceremony: a body whose result
// is never observed can be deleted outright by an optimising engine, and a
// benchmark of deleted code measures Infinity operations per second.
const expected = (items.length * (items.length - 1)) / 2
