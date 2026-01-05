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
    mainBtn: document.getElementById('main-btn'),
    secControls: document.getElementById('secondary-controls'),
    btnOpt1: document.getElementById('btn-option-1'),
    btnOpt2: document.getElementById('btn-option-2')
};

// Starter data - MUST match backend starters exactly
const startersByGen = {
    1: ['Bulbasaur', 'Charmander', 'Squirtle', 'Pikachu'],
    2: ['Chikorita', 'Cyndaquil', 'Totodile'],
    3: ['Treecko', 'Torchic', 'Mudkip'],
    4: ['Turtwig', 'Chimchar', 'Piplup'],
    5: ['Snivy', 'Tepig', 'Oshawott'],
    6: ['Chespin', 'Fennekin', 'Froakie'],
    7: ['Rowlet', 'Litten', 'Popplio'],
    8: ['Grookey', 'Scorbunny', 'Sobble']
};

/**
 * Start adventure events - labels in Portuguese
 * Must match backend startAdventureWeights events
 */
const startAdventureEvents = [
    { event: 'CATCH_POKEMON', label: 'Pokémon Selvagem' },
    { event: 'BATTLE_TRAINER', label: 'Treinador' },
    { event: 'BUY_POTIONS', label: 'Loja' },
    { event: 'NOTHING', label: 'Nada' }
];

if (els.playerName) els.playerName.textContent = user.first_name;

// --- CLASSE DA ROLETA (Baseada no wheel.component.ts) ---
class Roulette {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');
        this.items = [];
        this.rotation = 0;
        this.spinning = false;
        this.size = this.canvas.width;
        this.radius = this.size / 2;
        this.centerX = this.size / 2;
        this.centerY = this.size / 2;
    }

    // Desenha a roleta estática ou em movimento
    draw(rotation = 0) {
        this.rotation = rotation;
        const totalWeight = this.items.length; // Simplificado: peso 1 pra todos
        const arcSize = (2 * Math.PI) / totalWeight;
        
        this.ctx.clearRect(0, 0, this.size, this.size);

        let startAngle = rotation;
        
        // Cores padrão do jogo Pokémon
        const colors = ['#FF5959', '#F5AC78', '#FAE078', '#9DB7F5', '#A7DB8D', '#FA92B2'];

        for (let i = 0; i < this.items.length; i++) {
            const item = this.items[i];
            const endAngle = startAngle + arcSize;

            // Fatia
            this.ctx.beginPath();
            this.ctx.moveTo(this.centerX, this.centerY);
            this.ctx.arc(this.centerX, this.centerY, this.radius - 5, startAngle, endAngle);
            this.ctx.fillStyle = colors[i % colors.length];
            this.ctx.fill();
            this.ctx.stroke();

            // Texto
            this.ctx.save();
            this.ctx.translate(this.centerX, this.centerY);
            this.ctx.rotate(startAngle + arcSize / 2);
            this.ctx.textAlign = "right";
            this.ctx.fillStyle = "#fff";
            this.ctx.font = "bold 14px Arial";
            this.ctx.shadowColor = "black";
            this.ctx.shadowBlur = 2;
            this.ctx.fillText(item.label, this.radius - 20, 5);
            this.ctx.restore();

            startAngle = endAngle;
        }

        // Desenha o ponteiro (triângulo na direita)
        this.ctx.beginPath();
        this.ctx.moveTo(this.size - 10, this.centerY - 10);
        this.ctx.lineTo(this.size - 10, this.centerY + 10);
        this.ctx.lineTo(this.size - 30, this.centerY);
        this.ctx.fillStyle = "white";
        this.ctx.fill();
        this.ctx.stroke();
    }

    // Anima até parar no item alvo (targetLabel)
    spinTo(targetLabel, onComplete) {
        if (this.spinning) return;
        this.spinning = true;

        // Acha o índice do vencedor
        const winningIndex = this.items.findIndex(i => i.label === targetLabel);
        if (winningIndex === -1) {
            console.error("Item alvo não encontrado na roleta:", targetLabel);
            onComplete();
            return;
        }

        const totalWeight = this.items.length;
        const arcSize = (2 * Math.PI) / totalWeight;
        
        // Calcula onde a roleta deve parar para o ponteiro (que está na direita/0 graus) apontar para o item
        // No canvas, 0 radianos é as 3 horas (direita).
        const winningAngleStart = winningIndex * arcSize;
        
        // Lógica de rotação final: 
        // Queremos que o winningIndex esteja na posição 0 (direita) no final.
        // Adicionamos algumas voltas completas (5 voltas = 10 * PI)
        // Subtraímos o ângulo do item para trazê-lo para o zero.
        const totalRotations = 5; 
        const randomOffset = Math.random() * (arcSize * 0.8) + (arcSize * 0.1); // Aleatoriedade dentro da fatia
        
        // Fórmula mágica do wheel.component.ts adaptada
        // O item está em `winningAngleStart`. Para ele ir para 0, precisamos girar `-winningAngleStart`.
        const targetRotation = (totalRotations * 2 * Math.PI) - winningAngleStart - (arcSize/2); 

        const duration = 4000; // 4 segundos
        const startTime = performance.now();

        const animate = (currentTime) => {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);
            
            // Easing function (Cubic Ease Out) - faz desacelerar no final
            const ease = 1 - Math.pow(1 - progress, 3);
            
            const currentRotation = ease * targetRotation;
            this.draw(currentRotation);

            if (progress < 1) {
                requestAnimationFrame(animate);
            } else {
                this.spinning = false;
                onComplete();
            }
        };

        requestAnimationFrame(animate);
    }
}

const roulette = new Roulette('roulette-canvas');

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
        els.text.textContent = `Error: ${e.message}. 
Try closing and reopening.`;
        els.mainBtn.style.display = 'none'; // Esconde botão se deu erro
    }
}

// Variável para impedir cliques duplos durante animação
let isAnimating = false;
// Flag to prevent double-triggering during the entire gen roulette flow
let genRouletteInProgress = false;

/**
 * Generic action sender - for actions WITHOUT roulette animation
 * For roulette actions, use triggerGenRoulette, triggerStarterRoulette, etc.
 */
async function sendAction(action, payload = {}) {
    if (isAnimating) return;

    try {
        els.mainBtn.disabled = true;
        els.text.textContent = "Carregando...";

        const res = await fetch(`${API_BASE}/action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, action, ...payload })
        });
        
        if (!res.ok) {
            const errorData = await res.json().catch(() => ({}));
            throw new Error(errorData.error || 'Action failed');
        }
        
        const newState = await res.json();
        renderState(newState);

    } catch (e) {
        console.error('sendAction error:', e);
        els.text.textContent = `Erro: ${e.message}. Tente novamente.`;
        els.mainBtn.style.display = 'block';
        els.mainBtn.disabled = false;
    }
}

function setupRouletteUI(items) {
    // Esconde tudo e mostra só o Canvas
    els.sprite.style.display = 'none';
    els.text.textContent = "Sorteando...";
    els.mainBtn.style.display = 'none';
    els.secControls.style.display = 'none';
    
    const canvas = document.getElementById('roulette-canvas');
    canvas.style.display = 'block';
    
    roulette.items = items;
    roulette.draw(0);
}

// Função auxiliar para "adivinhar" o que a API escolheu para a roleta parar visualmente
function decideTargetLabel(action, state, items) {
    // Tenta encontrar algo nos itens que combine com o resultado
    // Como a API retorna o "Próximo Estado" e não exatamente "Você tirou X", 
    // precisamos inferir ou pegar o nome do Pokémon
    
    if (action === 'SPIN_STARTER') {
        const newPokemon = state.team[state.team.length - 1]; // O último pkm adicionado
        // Hack visual: substitui um dos itens da roleta pelo nome do pokemon que ganhamos
        // para garantir que a roleta pare no nome certo
        items[0].label = newPokemon.name; 
        return newPokemon.name;
    }
    
    if (action === 'SPIN_START_ADVENTURE' || action === 'SPIN_MAIN_ADVENTURE') {
        // Se mudou para GYM_BATTLE, foi batalha
        if (state.phase === 'GYM_BATTLE') return 'Batalha';
        // Se ganhou item, retorna Item, etc...
        // Para simplificar, vamos fazer o mesmo hack:
        // O backend deve mandar `lastEventResult` tipo "Você encontrou um Pidgey!"
        // Vamos forçar o item 0 a ser o resultado
        const resume = state.lastEventResult ? state.lastEventResult.split(' ')[0] + '...' : 'Sorte!';
        items[0].label = "Sorte!"; // Texto genérico ou extraído
        return "Sorte!";
    }

    return items[0].label; // Fallback
}

function renderState(state) {
    // Update Header
    els.badges.textContent = `🏅 ${state.badges}`;
    els.round.textContent = `Round ${state.round}/8`;

    // Reset UI
    els.sprite.style.display = 'none';
    // CORREÇÃO: Garante que a roleta suma quando renderizar um novo estado
    document.getElementById('roulette-canvas').style.display = 'none'; 
    els.secControls.style.display = 'none';
    els.mainBtn.style.display = 'none'; // Esconde botão principal por padrão em fases de escolha
    els.secControls.innerHTML = ''; // Limpa botões secundários

    // Render based on Phase
    if (!state.phase) state.phase = 'GEN_ROULETTE';

    switch (state.phase) {
        case 'GEN_ROULETTE':
            els.title.textContent = "🎰 Sorteio de Geração";
            els.text.textContent = "Toque em qualquer botão para descobrir sua geração!";
            els.secControls.style.display = 'flex';
            els.secControls.style.flexWrap = 'wrap';
            els.secControls.style.justifyContent = 'center';
            els.secControls.style.gap = '8px';
            
            for (let i = 1; i <= 8; i++) {
                const btn = document.createElement('button');
                btn.className = 'game-btn small';
                btn.style.width = '45px';
                btn.textContent = i;
                // ALL buttons trigger spin to the PRE-DETERMINED generation
                // state.generation was already set by backend's spinGen()
                btn.onclick = () => triggerGenRoulette(state.generation);
                els.secControls.appendChild(btn);
            }
            break;

        case 'GENDER_ROULETTE':
            els.title.textContent = "👤 Escolha seu Treinador";
            els.text.textContent = `🎉 Geração ${state.generation} sorteada! Você é menino ou menina?`;
            els.secControls.style.display = 'flex';
            els.secControls.style.gap = '12px';
            els.secControls.style.justifyContent = 'center';
            
            const btnBoy = document.createElement('button');
            btnBoy.className = 'game-btn';
            btnBoy.innerHTML = '👦<br>Menino';
            btnBoy.style.padding = '15px 25px';
            btnBoy.onclick = () => selectGender('male');
            
            const btnGirl = document.createElement('button');
            btnGirl.className = 'game-btn';
            btnGirl.innerHTML = '👧<br>Menina';
            btnGirl.style.padding = '15px 25px';
            btnGirl.onclick = () => selectGender('female');

            els.secControls.appendChild(btnBoy);
            els.secControls.appendChild(btnGirl);
            break;

        case 'STARTER_ROULETTE':
            els.title.textContent = "🎲 Seu Primeiro Parceiro";
            const genderLabel = state.gender === 'male' ? 'um Treinador' : 'uma Treinadora';
            els.text.textContent = `Você é ${genderLabel} da Geração ${state.generation}! Hora de conhecer seu Pokémon inicial.`;
            els.mainBtn.style.display = 'block';
            els.mainBtn.disabled = false;
            els.mainBtn.style.opacity = '1';
            els.mainBtn.textContent = "🎲 SORTEAR INICIAL";
            els.mainBtn.onclick = () => triggerStarterRoulette(state.generation);
            break;

        case 'START_ADVENTURE':
            const starterPokemon = state.team[0];

            if (!starterPokemon) {
                els.title.textContent = "⚠️ Erro";
                els.text.textContent = "Sessão inválida. Reiniciando...";
                setTimeout(() => sendAction('RESET'), 1500);
                break;
            }

            showPokemon(starterPokemon);

            // First time in START_ADVENTURE or after NOTHING event
            if (state.lastEvent === 'NOTHING') {
                els.title.textContent = "🤷 Nada aconteceu...";
                els.text.textContent = state.lastEventResult;
            } else if (!state.lastEvent) {
                // First time - just got starter
                const shinyPrefix = starterPokemon.shiny ? '✨ ' : '';
                const shinySuffix = starterPokemon.shiny ? ' ✨' : '';
                els.title.textContent = `${shinyPrefix}${starterPokemon.name}${shinySuffix}`;
                els.text.textContent = "Sua jornada começa agora! O que fará primeiro?";
            } else {
                // Returning from other state (shouldn't happen normally)
                els.title.textContent = `${starterPokemon.name}`;
                els.text.textContent = state.lastEventResult || "Continue sua aventura!";
            }

            els.mainBtn.style.display = 'block';
            els.mainBtn.disabled = false;
            els.mainBtn.style.opacity = '1';
            els.mainBtn.textContent = "🎲 EXPLORAR";
            els.mainBtn.onclick = () => triggerStartAdventureRoulette();
            break;

        case 'ADVENTURE':
            const activePokemon = state.team[0];

            if (activePokemon) {
                showPokemon(activePokemon);
            }

            els.title.textContent = "🌍 Aventura";

            // Show last event result
            if (state.lastEventResult) {
                els.text.textContent = state.lastEventResult;
            } else {
                els.text.textContent = "A aventura continua...";
            }

            // Show team count and items
            const teamInfo = `Time: ${state.team.length}/6`;
            const potionItem = state.items.find(i => i.id === 'potion');
            const potionCount = potionItem ? potionItem.count : 0;
            const itemInfo = `Poções: ${potionCount}`;

            els.round.textContent = `Round ${state.round}/8 | ${teamInfo} | ${itemInfo}`;

            els.mainBtn.style.display = 'block';
            els.mainBtn.disabled = false;
            els.mainBtn.style.opacity = '1';
            els.mainBtn.textContent = "🎲 CONTINUAR AVENTURA";
            els.mainBtn.onclick = () => sendAction('SPIN_MAIN_ADVENTURE'); // TODO: Implement
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

/**
 * Triggers the starter pokemon roulette
 * Backend picks the result, frontend animates to it
 */
async function triggerStarterRoulette(generation) {
    if (isAnimating) {
        console.log('Starter roulette already in progress');
        return;
    }
    
    isAnimating = true;
    
    // Disable button immediately
    els.mainBtn.disabled = true;
    els.mainBtn.style.opacity = '0.5';
    
    // Get starters for current generation
    const starters = startersByGen[generation] || startersByGen[1];
    
    // Setup roulette with actual starter names
    const starterItems = starters.map(name => ({ label: name }));
    setupRouletteUI(starterItems);
    els.text.textContent = "🎲 Sorteando seu parceiro...";
    
    try {
        // Call backend - it picks the starter and updates state
        const res = await fetch(`${API_BASE}/action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, action: 'SPIN_STARTER' })
        });
        
        if (!res.ok) {
            const errorData = await res.json().catch(() => ({}));
            throw new Error(errorData.error || `Server error: ${res.status}`);
        }
        
        const newState = await res.json();
        
        // Get the starter that was picked (should be first/only pokemon in team)
        const pickedStarter = newState.team[newState.team.length - 1]; // Get the most recent one
        
        if (!pickedStarter) {
            throw new Error('No starter received from server');
        }
        
        const targetLabel = pickedStarter.name;
        
        // Verify target exists in roulette items (safety check)
        const targetExists = starterItems.some(item => item.label === targetLabel);
        if (!targetExists) {
            console.warn(`Starter "${targetLabel}" not found in roulette, adding it`);
            // Replace first item with the actual result
            starterItems[0].label = targetLabel;
            roulette.items = starterItems;
            roulette.draw(0);
        }
        
        // Animate roulette to the picked starter
        roulette.spinTo(targetLabel, () => {
            // Update text to show result
            const shinyText = pickedStarter.shiny ? ' ✨SHINY✨' : '';
            els.text.textContent = `🎉 ${pickedStarter.name}${shinyText}!`;
            
            // Brief pause to admire the result
            setTimeout(() => {
                isAnimating = false;
                document.getElementById('roulette-canvas').style.display = 'none';
                renderState(newState);
            }, 1200);
        });
        
    } catch (e) {
        console.error('Error spinning starter:', e);
        isAnimating = false;
        
        // Hide roulette and show error
        document.getElementById('roulette-canvas').style.display = 'none';
        els.mainBtn.disabled = false;
        els.mainBtn.style.opacity = '1';
        els.mainBtn.style.display = 'block';
        els.text.textContent = `Erro: ${e.message}. Tente novamente.`;
    }
}

// Start
fetchGameState();

/**
 * Triggers the start adventure roulette animation.
 * Backend determines result, frontend syncs animation.
 */
async function triggerStartAdventureRoulette() {
    if (isAnimating) {
        console.log('Adventure roulette already in progress');
        return;
    }

    isAnimating = true;

    els.mainBtn.disabled = true;
    els.mainBtn.style.opacity = '0.5';

    const rouletteItems = startAdventureEvents.map(e => ({ label: e.label }));
    setupRouletteUI(rouletteItems);
    els.text.textContent = "🎲 O que vai acontecer...";

    try {
        const res = await fetch(`${API_BASE}/action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, action: 'SPIN_START_ADVENTURE' })
        });

        if (!res.ok) {
            const errorData = await res.json().catch(() => ({}));
            throw new Error(errorData.error || `Server error: ${res.status}`);
        }

        const newState = await res.json();

        // Find matching label for backend event
        const pickedEvent = newState.lastEvent;
        const targetItem = startAdventureEvents.find(e => e.event === pickedEvent);

        if (!targetItem) {
            throw new Error(`Unknown event: ${pickedEvent}`);
        }

        const targetLabel = targetItem.label;

        roulette.spinTo(targetLabel, () => {
            els.text.textContent = newState.lastEventResult || "Algo aconteceu!";

            setTimeout(() => {
                isAnimating = false;
                document.getElementById('roulette-canvas').style.display = 'none';
                renderState(newState);
            }, 1500);
        });

    } catch (e) {
        console.error('Error in start adventure:', e);
        isAnimating = false;

        document.getElementById('roulette-canvas').style.display = 'none';
        els.mainBtn.disabled = false;
        els.mainBtn.style.opacity = '1';
        els.mainBtn.style.display = 'block';
        els.text.textContent = `Erro: ${e.message}. Tente novamente.`;
    }
}

/**
 * Triggers the generation roulette animation
 * Safe to call multiple times - will only execute once per GEN_ROULETTE state
 * @param {number} targetGeneration - Pre-determined generation from backend
 */
async function triggerGenRoulette(targetGeneration) {
    // Guard: prevent any re-triggering
    if (isAnimating || genRouletteInProgress) {
        console.log('Gen roulette already in progress, ignoring click');
        return;
    }
    
    genRouletteInProgress = true;
    isAnimating = true;
    
    // Disable all generation buttons immediately
    document.querySelectorAll('#secondary-controls .game-btn').forEach(btn => {
        btn.disabled = true;
        btn.style.opacity = '0.5';
    });
    
    // Setup roulette with all 8 generations
    const genItems = [];
    for (let i = 1; i <= 8; i++) {
        genItems.push({ label: `Gen ${i}` });
    }
    
    setupRouletteUI(genItems);
    els.text.textContent = "🎰 Sorteando sua geração...";
    
    const targetLabel = `Gen ${targetGeneration}`;
    
    roulette.spinTo(targetLabel, async () => {
        // Show result briefly before transitioning
        els.text.textContent = `✨ Geração ${targetGeneration}!`;
        
        // Wait for user to see the result
        await new Promise(resolve => setTimeout(resolve, 1200));
        
        try {
            // Call backend to advance state (idempotent - safe if called twice)
            const res = await fetch(`${API_BASE}/action`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId, action: 'CONFIRM_GEN' })
            });
            
            if (!res.ok) {
                throw new Error(`Server error: ${res.status}`);
            }
            
            const newState = await res.json();
            
            // Successfully transitioned - render new state
            document.getElementById('roulette-canvas').style.display = 'none';
            isAnimating = false;
            genRouletteInProgress = false;
            renderState(newState);
            
        } catch (e) {
            console.error('Error confirming generation:', e);
            
            // Show error but keep the result visible
            els.text.textContent = `✨ Geração ${targetGeneration}! (Erro ao salvar, tentando novamente...)`;
            
            // Retry after delay
            setTimeout(async () => {
                isAnimating = false;
                genRouletteInProgress = false;
                await fetchGameState(); // Re-fetch will show correct state
            }, 2000);
        }
    });
}

/**
 * Handles gender selection (not a roulette - direct choice)
 * @param {'male' | 'female'} gender 
 */
async function selectGender(gender) {
    if (isAnimating) return;
    
    // Disable buttons to prevent double-click
    document.querySelectorAll('#secondary-controls .game-btn').forEach(btn => {
        btn.disabled = true;
    });
    
    els.text.textContent = "Salvando...";
    
    try {
        const res = await fetch(`${API_BASE}/action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, action: 'SELECT_GENDER', selection: gender })
        });
        
        if (!res.ok) throw new Error('Failed to select gender');
        
        const newState = await res.json();
        renderState(newState);
        
    } catch (e) {
        console.error('Error selecting gender:', e);
        els.text.textContent = "Erro ao salvar. Tente novamente.";
        
        // Re-enable buttons on error
        document.querySelectorAll('#secondary-controls .game-btn').forEach(btn => {
            btn.disabled = false;
        });
    }
}