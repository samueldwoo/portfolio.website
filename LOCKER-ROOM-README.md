# Basketball Locker Room Portfolio

An interactive 3D locker room experience where visitors can explore your content by clicking on lockers arranged in a circle.

## Features

- **3D Locker Room**: Circular arrangement of lockers with CSS 3D transforms
- **Interactive Controls**: 
  - Drag to rotate the view
  - Scroll to zoom in/out
  - Arrow keys for precise rotation
  - Click lockers to open content panels
- **Animated Background**: Particle system with floating stars
- **Auto-rotate**: Gentle rotation when idle
- **Smooth Animations**: All interactions are smoothly animated
- **Responsive**: Works on desktop and mobile

## How to Run Locally

### Option 1: Python Simple Server (Recommended)
```bash
python3 -m http.server 8000
```
Then open: `http://localhost:8000/locker-room.html`

### Option 2: Direct Open
Simply double-click `locker-room.html` or:
```bash
open locker-room.html
```

### Option 3: Node.js
```bash
npx serve
```
Then navigate to `locker-room.html`

## Controls

- **Mouse Drag**: Rotate the locker room view
- **Scroll**: Zoom in/out
- **Arrow Keys**: Rotate with keyboard
- **Click Locker**: Open content panel
- **ESC**: Close content panel
- **Auto-rotate**: After 5 seconds of inactivity

## Customization

### Change Locker Colors
Edit the `--color` CSS variable in `locker-room.html`:
```html
<div class="locker" data-locker="about" style="--angle: 0deg; --color: #4a90e2;">
```

### Add Your Content
Edit the content panels in `locker-room.html`:
```html
<div class="content-panel" id="aboutPanel">
    <div class="panel-inner">
        <h2>About Me</h2>
        <p>Your content here...</p>
    </div>
</div>
```

### Adjust Locker Positions
Change the `--angle` values to reposition lockers:
- 0deg = Front
- 90deg = Right
- 180deg = Back
- 270deg = Left

### Modify Center Logo
Edit the `.logo-text` in `locker-room.html`:
```html
<span class="logo-text">YOUR<br>INITIALS</span>
```

## File Structure

```
├── locker-room.html    # Main HTML structure
├── locker-room.css     # All styles and 3D effects
├── locker-room.js      # Interaction logic and animations
└── LOCKER-ROOM-README.md
```

## Deployment to Vercel

Same as the main site - just push to GitHub and deploy. Vercel will serve all HTML files.

## Browser Support

Works best in modern browsers with CSS 3D transform support:
- Chrome/Edge (recommended)
- Firefox
- Safari

## Performance Tips

- The particle system uses canvas for smooth 60fps animation
- 3D transforms are GPU-accelerated
- Smooth easing functions prevent jank
- Auto-rotate pauses during interaction

## Future Enhancements

Ideas to make it even cooler:
- Add sound effects (locker opening, ambient gym sounds)
- Add more lockers (up to 8-12 in the circle)
- Implement Three.js for true 3D rendering
- Add basketball court floor texture
- Animated basketball bouncing in center
- Team jersey hanging in lockers
- Lighting effects and shadows

## Inspiration

Inspired by Bruno Simon's legendary portfolio (bruno-simon.com) but with a basketball locker room theme instead of a driving game.
