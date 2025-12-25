const tg = window.Telegram.WebApp;
tg.expand(); // Expand to full height

// User info from Telegram
// Se initDataUnsafe não tiver user (ex: testando no navegador fora do TG), usa um ID fake
const user = tg.initDataUnsafe?.user || { id: 12345, first_name: 'TestUser' };
const userId = user.id;

// API Base URL (Relative path since we serve from the same bot)
// Se der erro de fetch, tente colocar a URL completa aqui para testar, mas relativo deve funcionar no Railway
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

if (els.playerName) els.playerName.textContent = user.first_name;

// --- GAME LOGIC ---

async function fetchGameState() {
    try {
        // Mostra loading inicial
        els.text.textContent = "Connecting to server...";
        
        const res = await fetch(`${API_BASE}/state?userId=${userId}`);
        
        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Server Error (${res.status}): ${errText}`);
        }

        const data = await res.json();
        renderState(data);
    } catch (e) {
        console.error(e);
        els.text.textContent = `Error: ${e.message}. \nTry closing and reopening.`;
        els.mainBtn.style.display = 'none'; // Esconde botão se deu erro
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
        
        if (!res.ok) throw new Error("Action failed");
        
        const data = await res.json();
        renderState(data);
    } catch (e) {
        console.error(e);
        els.text.textContent = "Connection lost. Tap to retry.";
        els.mainBtn.onclick = () => sendAction(action, payload);
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
    els.mainBtn.style.display = 'none'; // Esconde botão principal por padrão em fases de escolha
    els.secControls.innerHTML = ''; // Limpa botões secundários

    // Render based on Phase
    if (!state.phase) state.phase = 'GEN_ROULETTE';

    switch (state.phase) {
        case 'GEN_ROULETTE':
            els.title.textContent = "Escolha a Geração";
            els.text.textContent = "Selecione sua geração Pokémon favorita:";
            els.secControls.style.display = 'flex';
            els.secControls.style.flexWrap = 'wrap';
            els.secControls.style.justifyContent = 'center';
            
            for (let i = 1; i <= 8; i++) {
                const btn = document.createElement('button');
                btn.className = 'game-btn small';
                btn.style.width = '45px';
                btn.textContent = i;
                btn.onclick = () => sendAction('SELECT_GEN', { selection: i });
                els.secControls.appendChild(btn);
            }
            break;

        case 'GENDER_ROULETTE':
            els.title.textContent = "Informações do Treinador";
            els.text.textContent = `Geração ${state.generation} selecionada! Agora, você é Menino ou Menina?`;
            els.secControls.style.display = 'flex';
            
            const btnBoy = document.createElement('button');
            btnBoy.className = 'game-btn small';
            btnBoy.textContent = '👦 Menino';
            btnBoy.onclick = () => sendAction('SELECT_GENDER', { selection: 'male' });
            
            const btnGirl = document.createElement('button');
            btnGirl.className = 'game-btn small';
            btnGirl.textContent = '👧 Menina';
            btnGirl.onclick = () => sendAction('SELECT_GENDER', { selection: 'female' });

            els.secControls.appendChild(btnBoy);
            els.secControls.appendChild(btnGirl);
            break;

        case 'STARTER_ROULETTE':
            els.mainBtn.style.display = 'block'; // Volta o botão principal
            els.title.textContent = "Seu Parceiro";
            els.text.textContent = `Você é ${state.gender === 'male' ? 'um Menino' : 'uma Menina'}! Hora de pegar seu Pokémon Inicial.`;
            els.mainBtn.textContent = "🎲 PEGAR INICIAL";
            els.mainBtn.onclick = () => sendAction('SPIN_STARTER');
            break;

        case 'START_ADVENTURE':
            // Show starter
            const starter = state.team[0];
            if (starter) {
                showPokemon(starter);
                els.title.textContent = `Você obteve ${starter.name}!`;
                els.text.textContent = "Sua jornada começa. O que fará primeiro?";
                els.mainBtn.style.display = 'block';
                els.mainBtn.textContent = "🎲 GIRAR EVENTO";
                els.mainBtn.onclick = () => sendAction('SPIN_START_ADVENTURE');
            } else {
                // Estado inconsistente (sem time), reseta
                sendAction('RESET');
            }
            break;

        case 'ADVENTURE':
        case 'GYM_BATTLE':
            els.mainBtn.style.display = 'block';
            if (state.lastEventResult) {
                els.text.textContent = state.lastEventResult;
            } else {
                els.text.textContent = "A aventura aguarda...";
            }
            
            if (state.phase === 'GYM_BATTLE') {
                els.title.textContent = "⚔️ Batalha de Ginásio!";
                els.mainBtn.textContent = "⚔️ LUTAR COM LÍDER";
                els.mainBtn.onclick = () => sendAction('BATTLE_GYM');
            } else {
                els.title.textContent = "Aventura";
                els.mainBtn.textContent = "🎲 CONTINUAR";
                els.mainBtn.onclick = () => sendAction('SPIN_MAIN_ADVENTURE');
            }
            
            // Show current active pokemon
            if (state.team && state.team.length > 0) showPokemon(state.team[0]);
            break;
            
        case 'EVOLUTION':
            els.mainBtn.style.display = 'block';
            els.title.textContent = "Evolução?";
            els.text.textContent = state.lastEventResult || "Você ganhou a insígnia! Verificando evoluções...";
            els.mainBtn.textContent = "🧬 CHECAR EVOLUÇÃO";
            els.mainBtn.onclick = () => sendAction('EVOLVE');
            break;

        case 'VICTORY':
            els.mainBtn.style.display = 'block';
            els.title.textContent = "🏆 CAMPEÃO! 🏆";
            els.text.textContent = "Você derrotou todos os Líderes de Ginásio! Você é um Mestre Chernomon!";
            if (state.team && state.team.length > 0) showPokemon(state.team[0]); 
            els.mainBtn.textContent = "🔄 JOGAR NOVAMENTE";
            els.mainBtn.onclick = () => sendAction('RESET');
            break;

        case 'GAME_OVER':
            els.mainBtn.style.display = 'block';
            els.title.textContent = "☠️ FIM DE JOGO";
            els.text.textContent = state.lastEventResult || "Você desmaiou...";
            els.mainBtn.textContent = "🔄 REINICIAR";
            els.mainBtn.onclick = () => sendAction('RESET');
            break;
    }
}

function showPokemon(pokemon) {
    els.sprite.style.display = 'block';
    const shinyStr = pokemon.shiny ? 'shiny/' : '';
    const name = pokemon.name.toLowerCase().replace(/ /g, '-').replace(/[^a-z0-9-]/g, ''); 
    
    // Tenta carregar do PokeAPI primeiro que é mais estável
    const pokeApiUrl = `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${pokemon.shiny?'shiny/':''}${pokemon.id}.png`;
    
    els.sprite.src = pokeApiUrl;
}

// Start
fetchGameState();
