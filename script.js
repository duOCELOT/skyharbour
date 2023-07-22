let currentFrame = 0;
const frames = document.querySelectorAll('.frame');
const frameNames = ['Choose your Crew', 'Choose your Ship', 'Third Frame', 'Forth Frame', 'Fith Frame']; // Add more names as needed

function updateFrames() {
    frames.forEach((frame, index) => {
        if (index === currentFrame) {
            frame.classList.add('active');
            const frameNameElement = document.getElementById('frame-name');
            frameNameElement.innerHTML = '';
            const frameName = frameNames[index];
            for (let i = 0; i < frameName.length; i++) {
                const letter = document.createElement('span');
                letter.textContent = frameName[i];
                letter.style.animationDelay = `${i * 0.1}s`;
                frameNameElement.appendChild(letter);
            }
        } else {
            frame.classList.remove('active');
        }
    });
}

frames.forEach((frame) => {
    const frameParts = frame.querySelectorAll('.frame-part');
    frameParts.forEach((framePart) => {
        const cardImg = framePart.querySelector('img');
        framePart.addEventListener('mouseover', () => {
            cardImg.style.border = "5px solid orange";
        });
        framePart.addEventListener('mouseout', () => {
            cardImg.style.border = "none";
        });
    });
});

document.getElementById('prev-button').addEventListener('click', () => {
    currentFrame = Math.max(0, currentFrame - 1);
    updateFrames();
});

document.getElementById('next-button').addEventListener('click', () => {
    currentFrame = Math.min(frames.length - 1, currentFrame + 1);
    updateFrames();
});

updateFrames();  // Initialize
