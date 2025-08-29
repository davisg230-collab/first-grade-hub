# Classroom Border Image

## How to Replace the Border Image

1. Replace `classroom-border-top.png` with your actual classroom border image
2. The image should be designed to repeat horizontally (`repeat-x`)
3. Recommended height: 30px for optimal display
4. The image will appear at the top of the yellow header section
5. The border works on all screen sizes and in both light and dark modes

## Current Setup

- The CSS is configured to use `classroom-border-top.png` as the primary border image
- There's a fallback SVG demonstration border (`classroom-border-top.svg`) that shows the concept
- The border creates a "scalloped edge cutting into the yellow area" effect
- Responsive design ensures it works on desktop, tablet, and mobile devices

## Files Modified

- `/public/index.html` - Added CSS classes for the border and updated header element
- `/public/images/classroom-border-top.svg` - Demonstration border (can be removed after PNG is added)
- `/public/images/classroom-border-top.png` - Placeholder for actual border image