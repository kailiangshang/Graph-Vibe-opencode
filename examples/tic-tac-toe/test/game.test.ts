import { createBoard, makeMove, checkResult, render, isValidMove, type Board } from "../src/game"
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
  test("makeMove places the player marker", () => {
    const board = makeMove(createBoard(), 4, "X")
    expect(board[4]).toBe("X")
  })
  test("checkResult detects row win", () => {
    let board = createBoard()
    board = makeMove(board, 0, "X"); board = makeMove(board, 3, "O")
    board = makeMove(board, 1, "X"); board = makeMove(board, 4, "O")
    board = makeMove(board, 2, "X")
    expect(checkResult(board)).toBe("X-wins")
  })
  test("checkResult detects draw", () => {
    const board: Board = ["X", "O", "X", "X", "O", "O", "O", "X", "X"]
    expect(checkResult(board)).toBe("draw")
  })
  test("render shows position numbers for empty cells", () => {
    expect(render(createBoard())).toContain("4")
  })
})
