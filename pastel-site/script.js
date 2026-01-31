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
function showContent(sectionId, animationType = 'fade') {
    // Update active tab
    navTabs.forEach(tab => tab.classList.remove('active'));
    const activeTab = document.querySelector(`[data-panel="${sectionId}"]`);
    if (activeTab) {
        activeTab.classList.add('active');
    }
    
    // Get template content
    const template = document.getElementById(`${sectionId}-content`);
    if (!template) return;
    
    if (animationType === 'slide-down') {
        // Faster slide down animation
        mainContent.style.transition = 'transform 0.4s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.4s ease';
        mainContent.style.transform = 'translateY(100vh)';
        mainContent.style.opacity = '0';
        
        setTimeout(() => {
            mainContent.innerHTML = '';
            const content = template.content.cloneNode(true);
            mainContent.appendChild(content);
            
            // Scroll to top of page
            window.scrollTo(0, 0);
            
            // Start from above, slide down into view
            mainContent.style.transform = 'translateY(-100vh)';
            mainContent.style.opacity = '0';
            
            setTimeout(() => {
                mainContent.style.transform = 'translateY(0)';
                mainContent.style.opacity = '1';
                
                // Reset transition after animation
                setTimeout(() => {
                    mainContent.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
                }, 400);
                
                addMagneticEffects();
                initInteractiveElements();
            }, 50);
        }, 400);
    } else {
        // Default fade animation
        mainContent.style.opacity = '0';
        mainContent.style.transform = 'translateY(20px)';
        
        setTimeout(() => {
            mainContent.innerHTML = '';
            const content = template.content.cloneNode(true);
            mainContent.appendChild(content);
            
            // Force reflow to restart animations
            void mainContent.offsetWidth;
            
            mainContent.style.opacity = '1';
            mainContent.style.transform = 'translateY(0)';
            
            // Add magnetic effect to interactive elements
            addMagneticEffects();
            initInteractiveElements();
        }, 300);
    }
}

// Add magnetic effect to links and cards
function addMagneticEffects() {
    const magneticElements = document.querySelectorAll('.contact-link, .skills-list li');
    
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
    
    // Move floating blobs
    const blobs = document.querySelectorAll('.floating-blob');
    blobs.forEach((blob, index) => {
        const speed = (index + 1) * 0.5;
        blob.style.transform = `translate(${currentX * speed}px, ${currentY * speed}px)`;
    });
    
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

// Interactive name - shake on click
function initInteractiveName() {
    const name = document.getElementById('interactive-name');
    if (name) {
        name.addEventListener('click', () => {
            name.classList.add('shake');
            setTimeout(() => name.classList.remove('shake'), 500);
        });
    }
}

// Rotating subtitle
const subtitles = [
    'human, software engineer, robotics enthusiast',
    'volleyball player, foodie, vlogger',
    'gym rat, coffee drinker, Bay Area native',
    'builder of robots, writer of code, lover of good food'
];
let currentSubtitleIndex = 0;

function rotateSubtitle() {
    const subtitleEl = document.getElementById('rotating-subtitle');
    if (!subtitleEl) return;
    
    subtitleEl.classList.add('fade-out');
    
    setTimeout(() => {
        currentSubtitleIndex = (currentSubtitleIndex + 1) % subtitles.length;
        subtitleEl.textContent = subtitles[currentSubtitleIndex];
        subtitleEl.classList.remove('fade-out');
    }, 300);
}

// Start rotating subtitle every 4 seconds
setInterval(rotateSubtitle, 4000);

// CTA Explore - animate transition with slide-down
function initCTAExplore() {
    const ctas = document.querySelectorAll('.cta-explore');
    ctas.forEach(cta => {
        const nextSection = cta.getAttribute('data-next-section');
        if (nextSection) {
            cta.addEventListener('click', () => {
                showContent(nextSection, 'slide-down');
            });
        }
    });
}

// Initialize interactive elements on page load and content change
function initInteractiveElements() {
    initInteractiveName();
    initCTAExplore();
}

// Call on page load
document.addEventListener('DOMContentLoaded', () => {
    initInteractiveElements();
});

// Remove the wrapper that was breaking things
// Just call initInteractiveElements after showContent
