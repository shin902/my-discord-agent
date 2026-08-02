---
name: md2html
description: "Convert a Markdown file into a single self-contained offline HTML file. Available via pip install md2html-phuker."
---

# md2html skill

Convert a Markdown file into a single, fully self-contained HTML file with no CDN or external JavaScript dependencies.

## Conversion commands

```bash
# Basic conversion (generate input.html in the same directory)
md2html input.md

# Specify the output filename
md2html -o /workspace/output.html input.md

# Specify a style
md2html --style dark input.md        # Dark theme
md2html --style sidebar input.md     # Sidebar table of contents

# List available styles
md2html --list-styles
```

## Constraints

- Python 3 is required. Run it with `python3 -m md2html` or the `md2html` command.
- Input must be a file path (stdin is not supported).
- Local images are referenced only; they are not embedded in the HTML.
- The converted file is a completely standalone HTML file that can be opened directly in a browser.
