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

async function sendAction(action, payload = {}) {
    if (isAnimating) return; // Bloqueia se estiver rodando

    try {
        els.mainBtn.disabled = true;
        
        // 1. Prepara a Roleta antes de chamar a API (se for uma ação de sorteio)
        let rouletteItems = null;
        if (action === 'SPIN_STARTER') {
            // Exemplo: Lista hardcoded ou baseada na geração selecionada
            // Idealmente isso viria do backend, mas podemos simular para visual
            rouletteItems = [
                { label: 'Planta' }, { label: 'Fogo' }, { label: 'Água' }, { label: '???' } 
            ];
            setupRouletteUI(rouletteItems);
        } else if (action === 'SPIN_MAIN_ADVENTURE' || action === 'SPIN_START_ADVENTURE') {
             rouletteItems = [
                { label: 'Captura' }, { label: 'Batalha' }, { label: 'Item' }, { label: 'Nada' }
            ];
            setupRouletteUI(rouletteItems);
        } else {
             els.text.textContent = "Loading...";
        }

        // 2. Chama a API
        const res = await fetch(`${API_BASE}/action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, action, ...payload })
        });
        
        if (!res.ok) throw new Error("Action failed");
        const newState = await res.json();

        // 3. Se configuramos a roleta, rodamos ela até o resultado
        if (rouletteItems) {
            isAnimating = true;
            
            // Decidir qual label ganhar baseada no novo estado
            let targetLabel = decideTargetLabel(action, newState, rouletteItems);
            
            roulette.spinTo(targetLabel, () => {
                isAnimating = false;
                // Esconde roleta e mostra resultado final
                document.getElementById('roulette-canvas').style.display = 'none';
                els.sprite.style.display = 'block'; // Volta sprite se tiver
                renderState(newState);
            });
        } else {
            // Sem roleta, renderiza direto
            renderState(newState);
        }

    } catch (e) {
        console.error(e);
        isAnimating = false;
        els.text.textContent = "Erro de conexão. Tente de novo.";
        
        // CORREÇÃO CRÍTICA: Se der erro, mostra o botão de novo para o usuário tentar clicar
        els.mainBtn.style.display = 'block'; 
        els.mainBtn.disabled = false;
    } finally {
        if (!isAnimating) els.mainBtn.disabled = false;
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