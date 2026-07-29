Three ways to sum an array of 10,000 numbers. Engines optimise these very
differently, so the ranking is browser-specific: that is the whole point of
running the benchmark yourself rather than trusting a blog post.

This directory is the example layout `jsperf-pack` reads:

    case.json    title and options
    info.md      this text
    setup.js     runs before each sample, outside the measured body
    tests/*.js   one measured body per file, ordered by filename
