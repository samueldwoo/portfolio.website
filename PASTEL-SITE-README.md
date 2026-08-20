# Portfolio Website

A minimalist, retro-inspired portfolio website with sliding side panels.

## Features

- Clean, retro typography inspired by classic web design
- Sliding side panel navigation (inspired by Cotogna SF)
- Fully responsive design
- Static HTML/CSS/JS (no build step required)
- Vercel-ready deployment

## Local Development

Simply open `index.html` in your browser. No build process needed!

## Deployment to Vercel

### Option 1: Using Vercel CLI
```bash
npm i -g vercel
vercel
```

### Option 2: Using Git + Vercel Dashboard
1. Push this code to a GitHub repository
2. Go to [vercel.com](https://vercel.com)
3. Click "New Project"
4. Import your GitHub repository
5. Click "Deploy" (no configuration needed!)

## Customization

### Update Your Information
Edit `index.html` to add your:
- Name and title
- About section
- Projects
- Experience
- Contact links

### Contact Form
The contact form uses Formspree. To enable it:
1. Go to [formspree.io](https://formspree.io)
2. Create a free account
3. Create a new form
4. Replace `YOUR_FORM_ID` in the form action with your actual form ID

### Colors
Edit the CSS variables in `styles.css`:
```css
:root {
    --bg-color: #faf9f6;
    --text-color: #2a2a2a;
    --accent-color: #8b7355;
    --border-color: #d4c5b9;
    --panel-bg: #ffffff;
    --hover-color: #6b5745;
}
```

## Structure

```
├── index.html      # Main HTML file
├── styles.css      # All styles
├── script.js       # Panel navigation logic
├── vercel.json     # Vercel configuration
└── README.md       # This file
```

## Browser Support

Works in all modern browsers (Chrome, Firefox, Safari, Edge).
