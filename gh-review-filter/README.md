# GitHub Review Filter

Buttons on PR "Files changed" pages to hide tests, generated files, `.scratch` files and docs. Each button cycles: hide matching files (blue) → show only matching files (green) → off.

Install: `chrome://extensions` → enable Developer mode → Load unpacked → pick this folder. After edits, hit reload on the extension card.

Filter rules live at the top of `content.js`.
