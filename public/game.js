const tg = window.Telegram.WebApp;
tg.expand(); // Expand to full height

// User info from Telegram
const user = tg.initDataUnsafe.user;
const userId = user ? user.id : 0; // Fallback for testing outside TG

// API Base URL (Relative path since we serve from the same bot)
const API_BASE = '/api/game';

// DOM Elements
const els = {
    playerName: document.getElementById('player-name'),
    badges: document.getElementById('badges-count'),
    round: document.getElementById('round-info'),
    title: document.getElementById('scene-title'),
    text: document.getElementById('scene-text'),
    sprite: document.getElementById('main-sprite'),
    wheel: document.getElementById('roulette-wheel'),
    mainBtn: document.getElementById('main-btn'),
    secControls: document.getElementById('secondary-controls'),
    btnOpt1: document.getElementById('btn-option-1'),
    btnOpt2: document.getElementById('btn-option-2')
};

if (user) {
    els.playerName.textContent = user.first_name;
}

// --- GAME LOGIC ---

async function fetchGameState() {
    try {
        const res = await fetch(`${API_BASE}/state?userId=${userId}`);
        const data = await res.json();
        renderState(data);
    } catch (e) {
        console.error(e);
        els.text.textContent = "Error connecting to server...";
    }
}

async function sendAction(action, payload = {}) {
    try {
        els.mainBtn.disabled = true;
        els.text.textContent = "Loading...";
        
        const res = await fetch(`${API_BASE}/action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, action, ...payload })
        });
        const data = await res.json();
        renderState(data);
    } catch (e) {
        console.error(e);
    } finally {
        els.mainBtn.disabled = false;
    }
}

function renderState(state) {
    // Update Header
    els.badges.textContent = `🏅 ${state.badges}`;
    els.round.textContent = `Round ${state.round}/8`;

    // Reset UI
    els.sprite.style.display = 'none';
    els.wheel.style.display = 'none';
    els.secControls.style.display = 'none';
    els.mainBtn.style.display = 'block';
    els.mainBtn.onclick = null;

    // Render based on Phase
    switch (state.phase) {
        case 'GEN_ROULETTE':
            els.title.textContent = "Choose Generation";
            els.text.textContent = "Spin the roulette to pick your Pokémon Generation!";
            els.wheel.style.display = 'block';
            els.mainBtn.textContent = "🎲 SPIN GENERATION";
            els.mainBtn.onclick = () => sendAction('SPIN_GEN');
            break;

        case 'GENDER_ROULETTE':
            els.title.textContent = "Trainer Info";
            els.text.textContent = `Generation ${state.generation} selected! Now, are you a Boy or a Girl?`;
            els.mainBtn.textContent = "🎲 SPIN GENDER";
            els.mainBtn.onclick = () => sendAction('SPIN_GENDER');
            break;

        case 'STARTER_ROULETTE':
            els.title.textContent = "Your Partner";
            els.text.textContent = `You are a ${state.gender === 'male' ? 'Boy' : 'Girl'}! Time to get your Starter Pokémon.`;
            els.mainBtn.textContent = "🎲 GET STARTER";
            els.mainBtn.onclick = () => sendAction('SPIN_STARTER');
            break;

        case 'START_ADVENTURE':
            // Show starter
            const starter = state.team[0];
            if (starter) {
                showPokemon(starter);
                els.title.textContent = `You got ${starter.name}!`;
                els.text.textContent = "Your journey begins. What will you do first?";
                els.mainBtn.textContent = "🎲 SPIN EVENT";
                els.mainBtn.onclick = () => sendAction('SPIN_START_ADVENTURE');
            }
            break;

        case 'ADVENTURE':
        case 'GYM_BATTLE':
            if (state.lastEventResult) {
                els.text.textContent = state.lastEventResult;
            }
            
            if (state.phase === 'GYM_BATTLE') {
                els.title.textContent = "⚔️ Gym Battle!";
                els.mainBtn.textContent = "⚔️ FIGHT LEADER";
                els.mainBtn.onclick = () => sendAction('BATTLE_GYM');
            } else {
                els.title.textContent = "Adventure";
                els.mainBtn.textContent = "🎲 CONTINUE";
                els.mainBtn.onclick = () => sendAction('SPIN_MAIN_ADVENTURE');
            }
            
            // Show current active pokemon
            if (state.team.length > 0) showPokemon(state.team[0]);
            break;
            
        case 'EVOLUTION':
            els.title.textContent = "Evolution?";
            els.text.textContent = "You won the badge! Checking for evolutions...";
            els.mainBtn.textContent = "🧬 CHECK EVOLUTION";
            els.mainBtn.onclick = () => sendAction('EVOLVE');
            break;

        case 'VICTORY':
            els.title.textContent = "🏆 CHAMPION! 🏆";
            els.text.textContent = "You have defeated all Gym Leaders! You are the Chernomon Master!";
            if (state.team.length > 0) showPokemon(state.team[0]); // MVP
            els.mainBtn.textContent = "🔄 PLAY AGAIN";
            els.mainBtn.onclick = () => sendAction('RESET');
            break;

        case 'GAME_OVER':
            els.title.textContent = "☠️ GAME OVER";
            els.text.textContent = "You blacked out...";
            els.mainBtn.textContent = "🔄 RESTART";
            els.mainBtn.onclick = () => sendAction('RESET');
            break;
    }
}

function showPokemon(pokemon) {
    els.sprite.style.display = 'block';
    // Use Showdown sprites or PokeAPI
    const shinyStr = pokemon.shiny ? 'shiny/' : '';
    // Fix names for URL (lowercase)
    const name = pokemon.name.toLowerCase(); 
    els.sprite.src = `https://img.pokemondb.net/sprites/home/${shinyStr}${name}.png`;
    
    // Fallback if image fails (some names differ)
    els.sprite.onerror = () => {
        els.sprite.src = `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${pokemon.shiny?'shiny/':''}${pokemon.id}.png`;
    };
}

// Start
fetchGameState();
