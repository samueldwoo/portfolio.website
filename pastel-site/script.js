// Get all navigation tabs
const navTabs = document.querySelectorAll('.nav-tab');
const mainContent = document.getElementById('main-content');

// Magnetic effect for nav tabs
navTabs.forEach(tab => {
    tab.addEventListener('mousemove', (e) => {
        const rect = tab.getBoundingClientRect();
        const x = e.clientX - rect.left - rect.width / 2;
        const y = e.clientY - rect.top - rect.height / 2;
        
        tab.style.transform = `translate(${x * 0.2}px, ${y * 0.2}px) scale(1.05)`;
    });
    
    tab.addEventListener('mouseleave', () => {
        tab.style.transform = '';
    });
});

// Function to show content
function showContent(sectionId) {
    // Update active tab
    navTabs.forEach(tab => tab.classList.remove('active'));
    const activeTab = document.querySelector(`[data-panel="${sectionId}"]`);
    if (activeTab) {
        activeTab.classList.add('active');
    }
    
    // Get template content
    const template = document.getElementById(`${sectionId}-content`);
    if (!template) return;
    
    // Update content with fade effect
    mainContent.style.opacity = '0';
    mainContent.style.transform = 'translateY(20px)';
    
    setTimeout(() => {
        mainContent.innerHTML = '';
        const content = template.content.cloneNode(true);
        mainContent.appendChild(content);
        mainContent.style.opacity = '1';
        mainContent.style.transform = 'translateY(0)';
        
        // Add magnetic effect to interactive elements
        addMagneticEffects();
    }, 300);
}

// Add magnetic effect to links and cards
function addMagneticEffects() {
    const magneticElements = document.querySelectorAll('.contact-link, .skill-tag, .project-card, .work-item');
    
    magneticElements.forEach(el => {
        el.addEventListener('mousemove', (e) => {
            const rect = el.getBoundingClientRect();
            const x = e.clientX - rect.left - rect.width / 2;
            const y = e.clientY - rect.top - rect.height / 2;
            
            el.style.transform = `translate(${x * 0.15}px, ${y * 0.15}px) scale(1.02)`;
        });
        
        el.addEventListener('mouseleave', () => {
            el.style.transform = '';
        });
    });
}

// Add click event to navigation tabs
navTabs.forEach(tab => {
    tab.addEventListener('click', () => {
        const sectionId = tab.getAttribute('data-panel');
        showContent(sectionId);
    });
});

// Initialize magnetic effects on page load
document.addEventListener('DOMContentLoaded', () => {
    addMagneticEffects();
});

// Close on Escape key - show home
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        showContent('home');
    }
});

// Dark Mode Toggle
const darkModeToggle = document.getElementById('dark-mode-toggle');
const toggleIcon = darkModeToggle.querySelector('.toggle-icon');
const body = document.body;

// Load saved theme preference (default to dark)
const savedTheme = localStorage.getItem('theme') || 'dark';
if (savedTheme === 'dark') {
    body.classList.add('dark-mode');
    toggleIcon.textContent = '☀️';
} else {
    body.classList.remove('dark-mode');
    toggleIcon.textContent = '🌙';
}

// Handle theme toggle
darkModeToggle.addEventListener('click', () => {
    body.classList.toggle('dark-mode');
    
    // Update icon
    if (body.classList.contains('dark-mode')) {
        toggleIcon.textContent = '☀️';
        localStorage.setItem('theme', 'dark');
    } else {
        toggleIcon.textContent = '🌙';
        localStorage.setItem('theme', 'light');
    }
});

// Subtle parallax effect on mouse move
let mouseX = 0;
let mouseY = 0;
let currentX = 0;
let currentY = 0;

document.addEventListener('mousemove', (e) => {
    mouseX = (e.clientX / window.innerWidth - 0.5) * 20;
    mouseY = (e.clientY / window.innerHeight - 0.5) * 20;
});

function animateParallax() {
    currentX += (mouseX - currentX) * 0.1;
    currentY += (mouseY - currentY) * 0.1;
    
    const blobs = document.querySelectorAll('body::before, body::after');
    document.body.style.setProperty('--mouse-x', `${currentX}px`);
    document.body.style.setProperty('--mouse-y', `${currentY}px`);
    
    requestAnimationFrame(animateParallax);
}

animateParallax();

// Add ripple effect on click
document.addEventListener('click', (e) => {
    const ripple = document.createElement('div');
    ripple.className = 'ripple';
    ripple.style.left = e.clientX + 'px';
    ripple.style.top = e.clientY + 'px';
    document.body.appendChild(ripple);
    
    setTimeout(() => ripple.remove(), 600);
});
