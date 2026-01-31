// Get all navigation tabs
const navTabs = document.querySelectorAll('.nav-tab');
const mainContent = document.getElementById('main-content');

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
    
    setTimeout(() => {
        mainContent.innerHTML = '';
        const content = template.content.cloneNode(true);
        mainContent.appendChild(content);
        mainContent.style.opacity = '1';
    }, 300);
}

// Add click event to navigation tabs
navTabs.forEach(tab => {
    tab.addEventListener('click', () => {
        const sectionId = tab.getAttribute('data-panel');
        showContent(sectionId);
    });
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
