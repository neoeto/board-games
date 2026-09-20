import { useState } from "react";

type GameId = "go" | "xiangqi";

type Game = {
  id: GameId;
  name: string;
  nativeName: string;
  origin: string;
  description: string;
  principle: string;
};

const games: readonly Game[] = [
  {
    id: "go",
    name: "Go",
    nativeName: "圍棋",
    origin: "Ancient China",
    description:
      "Build influence across an open field. Every quiet move changes the value of the whole board.",
    principle: "Surround territory with fewer, more patient moves.",
  },
  {
    id: "xiangqi",
    name: "Xiangqi",
    nativeName: "象棋",
    origin: "China",
    description:
      "Command two armies divided by a river. Pressure arrives quickly, but position still decides the contest.",
    principle: "Coordinate distinct pieces across the river and palace.",
  },
];

function GoBoard() {
  return (
    <div className="board go-board" aria-hidden="true">
      <span className="go-stone go-stone-black stone-one" />
      <span className="go-stone go-stone-white stone-two" />
      <span className="go-stone go-stone-black stone-three" />
      <span className="go-stone go-stone-white stone-four" />
      <span className="go-stone go-stone-black stone-five" />
    </div>
  );
}

function XiangqiBoard() {
  return (
    <div className="board xiangqi-board" aria-hidden="true">
      <span className="river-label">楚河&nbsp;&nbsp;&nbsp;&nbsp;漢界</span>
      <span className="xiangqi-piece piece-red piece-general">帥</span>
      <span className="xiangqi-piece piece-red piece-cannon">炮</span>
      <span className="xiangqi-piece piece-black piece-general-black">將</span>
      <span className="xiangqi-piece piece-black piece-horse">馬</span>
    </div>
  );
}

function App() {
  const [selectedGameId, setSelectedGameId] = useState<GameId>("go");
  const selectedGame = games.find((game) => game.id === selectedGameId) ?? games[0];

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Just Go home">
          <span className="brand-mark" aria-hidden="true">棋</span>
          <span>Just Go</span>
        </a>
        <p className="header-note">Two classics, one quiet room</p>
      </header>

      <main id="top" className="main-content">
        <section className="intro" aria-labelledby="page-title">
          <p className="eyebrow">A browser board room</p>
          <h1 id="page-title">Choose the game that asks you to think further.</h1>
          <p className="intro-copy">
            Begin with the character of each tradition, presented in a calm space built for deliberate play.
          </p>
        </section>

        <section className="game-room" aria-labelledby="game-selector-title">
          <div className="game-selector">
            <div className="section-heading">
              <p className="section-kicker">Select a tradition</p>
              <h2 id="game-selector-title">The board changes. The attention stays.</h2>
            </div>

            <div className="game-options" role="group" aria-label="Game selection">
              {games.map((game, index) => {
                const isSelected = game.id === selectedGame.id;

                return (
                  <button
                    className={`game-option${isSelected ? " is-selected" : ""}`}
                    key={game.id}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => setSelectedGameId(game.id)}
                  >
                    <span className="choice-number">0{index + 1}</span>
                    <span className="choice-copy">
                      <span className="choice-title">
                        {game.name}
                        <span lang="zh-Hant">{game.nativeName}</span>
                      </span>
                      <span className="choice-origin">{game.origin}</span>
                    </span>
                    <span className="selection-mark" aria-hidden="true" />
                  </button>
                );
              })}
            </div>

            <div className="selection-details" aria-live="polite">
              <p>{selectedGame.description}</p>
              <dl>
                <div>
                  <dt>Guiding idea</dt>
                  <dd>{selectedGame.principle}</dd>
                </div>
                <div>
                  <dt>Release status</dt>
                  <dd>Interface preview</dd>
                </div>
              </dl>
            </div>
          </div>

          <div className="board-stage">
            <div className="stage-caption">
              <div>
                <span>Selected board</span>
                <strong>{selectedGame.name}</strong>
              </div>
              <span className="native-title" lang="zh-Hant">{selectedGame.nativeName}</span>
            </div>
            <div className="board-wrap">
              {selectedGame.id === "go" ? <GoBoard /> : <XiangqiBoard />}
            </div>
            <p className="stage-note">
              Board preview only. Rules, computer opponents, and network play are not included in this release.
            </p>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <p>Phase one establishes the room, the boards, and the choice between them.</p>
        <span>Go · Xiangqi · Browser</span>
      </footer>
    </div>
  );
}

export default App;
