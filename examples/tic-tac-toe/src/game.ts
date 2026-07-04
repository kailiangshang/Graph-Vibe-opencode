export type Cell = " " | "X" | "O"
export type Board = [Cell, Cell, Cell, Cell, Cell, Cell, Cell, Cell, Cell]
export type Player = "X" | "O"
export type GameResult = "playing" | "X-wins" | "O-wins" | "draw"

export function createBoard(): Board {
  return [" ", " ", " ", " ", " ", " ", " ", " ", " "]
}

export function isValidMove(board: Board, position: number): boolean {
  return position >= 0 && position < 9 && board[position] === " "
}

export function makeMove(board: Board, position: number, player: Player): Board {
  if (!isValidMove(board, position)) throw new Error(`Invalid move at position ${position}`)
  const next = [...board] as Board
  next[position] = player
  return next
}

const WIN_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
]

export function checkResult(board: Board): GameResult {
  for (const [a, b, c] of WIN_LINES) {
    if (board[a] !== " " && board[a] === board[b] && board[a] === board[c]) {
      return board[a] === "X" ? "X-wins" : "O-wins"
    }
  }
  return board.includes(" ") ? "playing" : "draw"
}

export function render(board: Board): string {
  const r = (i: number) => board[i] === " " ? String(i) : board[i]
  return [
    ` ${r(0)} | ${r(1)} | ${r(2)} `,
    "---+---+---",
    ` ${r(3)} | ${r(4)} | ${r(5)} `,
    "---+---+---",
    ` ${r(6)} | ${r(7)} | ${r(8)} `,
  ].join("\n")
}
