# Design elements and standards for handsbreadth web site

## Brand Color Palette

The palette is organized into four groups: Brand, Interactive, Text, and Surface.
The brand voice is "Mobile. Effective. Innovative." — the colors reflect trust,
depth, and forward motion, with teal as the distinctive differentiator.

### Brand Colors

| Role | Hex | Description |
|---|---|---|
| Brand Primary | `#182471` | Deep navy — the anchor of the brand; used for headers, the logo field, primary buttons, and the nav bar |
| Brand Secondary | `#2664c8` | Royal blue — supports the primary; used for section headers, hover states, and secondary buttons |
| Brand Accent | `#4dd2c2` | Teal — the most distinctive color in the palette; used for calls to action, active indicators, icons, badges, and highlight bars |
| Brand Tertiary | `#5d32a4` | Purple — used for gradient transitions between navy and teal, premium feature callouts, and decorative elements |

### Functional Colors

| Role | Hex | Description |
|---|---|---|
| Success / Positive | `#6FB768` | Medium green — success states, positive indicators, confirmations, and "go" actions |

### Interactive Colors

| Role | Hex | Description |
|---|---|---|
| Link / Interactive | `#337ab7` | Medium blue — hyperlinks and inline interactive text |

### Text Colors

| Role | Hex | Description |
|---|---|---|
| Text Primary | `#333333` | Dark gray — body copy and default text |
| Text Inverse | `#ffffff` | White — text on dark or colored backgrounds |
| Text High Contrast | `#000000` | Black — small print, captions, maximum contrast situations |

### Surface Colors

| Role | Hex | Description |
|---|---|---|
| Surface Light | `#ffffff` | White — primary page background |
| Surface Mid | `#c7c7c7` | Light gray — card borders, dividers, subtle section backgrounds, disabled states |

---

## Usage Notes

- **Primary background** is always `#ffffff` (white) with `#333333` body text.
- **Dark sections** (hero, footer, nav) use `#182471` background with `#ffffff` text.
- **Accent highlights** (CTA buttons, active nav items, feature icons) use `#4dd2c2` on either light or dark backgrounds.
- **Gradient** from `#182471` → `#2664c8` → `#5d32a4` works well for hero banners and full-width section dividers.
- **Never place** `#c7c7c7` text on `#ffffff` — insufficient contrast for body text.
- **Link color** `#337ab7` is for inline text links only; buttons use Brand colors, not the link color.

---

## Source Colors (from live site stylesheets)

### Background Colors
#ffffff
#c7c7c7
#4dd2c2
#2664c8
#5d32a4
#182471

### Additional Colors
#6FB768

### Text Colors
#ffffff
#337ab7
#333333
#000000