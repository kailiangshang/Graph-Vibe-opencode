import { createBoard, makeMove, checkResult, render, isValidMove, type Board, type Player } from "../src/game"
import { describe, expect, test } from "bun:test"

describe("tic-tac-toe", () => {
  test("createBoard returns empty board", () => {
    expect(createBoard()).toEqual([" ", " ", " ", " ", " ", " ", " ", " ", " "])
  })

  test("isValidMove rejects occupied positions", () => {
    const board = makeMove(createBoard(), 0, "X")
    expect(isValidMove(board, 0)).toBe(false)
    expect(isValidMove(board, 1)).toBe(true)
  })

  test("isValidMove rejects out-of-range positions", () => {
    const board = createBoard()
    expect(isValidMove(board, -1)).toBe(false)
    expect(isValidMove(board, 9)).toBe(false)
  })

  test("makeMove places the player marker", () => {
    const board = makeMove(createBoard(), 4, "X")
    expect(board[4]).toBe("X")
  })

  test("makeMove throws on occupied position", () => {
    const board = makeMove(createBoard(), 0, "X")
    expect(() => makeMove(board, 0, "O")).toThrow("Invalid move")
  })

  test("checkResult detects row win", () => {
    let board = createBoard()
    board = makeMove(board, 0, "X")
    board = makeMove(board, 3, "O")
    board = makeMove(board, 1, "X")
    board = makeMove(board, 4, "O")
    board = makeMove(board, 2, "X")
    expect(checkResult(board)).toBe("X-wins")
  })

  test("checkResult detects diagonal win", () => {
    let board = createBoard()
    board = makeMove(board, 0, "O")
    board = makeMove(board, 1, "X")
    board = makeMove(board, 4, "O")
    board = makeMove(board, 2, "X")
    board = makeMove(board, 8, "O")
    expect(checkResult(board)).toBe("O-wins")
  })

  test("checkResult detects draw", () => {
    const board: Board = ["X", "O", "X", "X", "O", "O", "O", "X", "X"]
    expect(checkResult(board)).toBe("draw")
  })

  test("checkResult returns playing for incomplete board", () => {
    expect(checkResult(createBoard())).toBe("playing")
  })

  test("render shows position numbers for empty cells", () => {
    const output = render(createBoard())
    expect(output).toContain("0")
    expect(output).toContain("4")
    expect(output).toContain("8")
  })
})
