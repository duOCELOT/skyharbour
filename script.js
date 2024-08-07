let currentFrame = 0;
const frames = document.querySelectorAll('.frame');
const frameNames = ['HOME', 'STORY', 'NFTs', 'FACTIONS', 'RACES', 'SKILLS', 'EXPLORATION', 'MISSIONS', 'ARTIFACTS', 'GALAXY', 'LEGENDS'];
const bottomButtons = document.querySelectorAll('.bottom-div .item_button');

// Function to update the active frame
function updateFrames() {
    frames.forEach((frame, index) => {
        frame.classList.toggle('active', index === currentFrame);

        if (index === currentFrame) {
            // Add the glitch class to the new active frame
            frame.classList.add('frame-glitch');
            // Reset the glitch effect after it runs
            setTimeout(() => {
                frame.classList.remove('frame-glitch');
            }, 1000); // Animation duration

            // Update the frame name display
            const frameNameElement = document.getElementById('frame-name');
            frameNameElement.innerHTML = frameNames[index].split('')
                .map((char, i) => `<span style="animation-delay:${i * 0.2}s">${char}</span>`)
                .join('');
        } else {
            // Remove the glitch class from all other frames
            frame.classList.remove('frame-glitch');
        }
    });
}

// Event listeners for bottom navigation buttons
bottomButtons.forEach((button, index) => {
    button.addEventListener('click', () => {
        currentFrame = index;
        updateFrames();
    });
});

// Event listeners for frame-part hover effects
frames.forEach((frame) => {
    const frameParts = frame.querySelectorAll('.frame-part');
    frameParts.forEach((framePart) => {
        const cardImg = framePart.querySelector('img');
        framePart.addEventListener('mouseover', () => {
            cardImg.style.border = "0px solid orange";
        });
        framePart.addEventListener('mouseout', () => {
            cardImg.style.border = "none";
        });
    });
});

// Event listeners for prev and next buttons
document.getElementById('prev-button').addEventListener('click', () => {
    currentFrame = Math.max(0, currentFrame - 1);
    updateFrames();
});

document.getElementById('next-button').addEventListener('click', () => {
    currentFrame = Math.min(frames.length - 1, currentFrame + 1);
    updateFrames();
});

// Initialize the frames display
updateFrames();
