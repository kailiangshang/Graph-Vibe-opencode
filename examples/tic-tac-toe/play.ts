import { createBoard, makeMove, checkResult, render, type Board, type Player } from "./src/game"

const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]] as const

function bestMove(board: Board, player: Player): number {
  for (const [a, b, c] of lines) {
    const line = [board[a], board[b], board[c]]
    const empty = [a, b, c].filter((i) => board[i] === " ")
    if (line.filter((x) => x === player).length === 2 && empty.length === 1) return empty[0]
    if (line.filter((x) => x === (player === "X" ? "O" : "X")).length === 2 && empty.length === 1) return empty[0]
  }
  if (board[4] === " ") return 4
  const corners = [0, 2, 6, 8].filter((i) => board[i] === " ")
  if (corners.length) return corners[0]
  return board.findIndex((c) => c === " ")
}

let board = createBoard()
let player: Player = "X"
console.log("=== Tic-Tac-Toe (X vs O) ===\n")
console.log(render(board))
while (checkResult(board) === "playing") {
  const pos = bestMove(board, player)
  board = makeMove(board, pos, player)
  console.log(`\n${player} → ${pos}\n`)
  console.log(render(board))
  player = player === "X" ? "O" : "X"
}
console.log(`\n=== ${checkResult(board)} ===`)
