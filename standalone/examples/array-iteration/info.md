Three ways to sum an array of 10,000 numbers, plus `reduce`. Engines optimise
these very differently, so the ranking is browser-specific: that is the whole
point of running the benchmark yourself rather than trusting a blog post.

Each test checks its own result. Do the same in your own cases - a test body
whose result is never observed can be optimised away completely, and the runner
will tell you it was rather than report a suspiciously fast number.

This directory is the layout `jsperf-pack` reads:

    case.json    title and options
    info.md      this text
    setup.js     runs before each sample, outside the measured body
    tests/*.js   one measured body per file, ordered by filename
