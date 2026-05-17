export const TODO_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
] as const;

export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface TodoItem {
  id: string;
  description: string;
  status: TodoStatus;
}

export class TodoManager {
  private todos: TodoItem[] = [];

  create(descriptions: string[]): TodoItem[] {
    this.todos = descriptions.map((description, index) => ({
      id: String(index + 1),
      description,
      status: "pending",
    }));
    return this.getAll();
  }

  updateStatus(id: string, status: TodoStatus): TodoItem | undefined {
    let updatedItem: TodoItem | undefined;
    this.todos = this.todos.map((todo) => {
      if (todo.id !== id) return todo;
      updatedItem = { ...todo, status };
      return updatedItem;
    });
    return updatedItem;
  }

  getAll(): TodoItem[] {
    return this.todos.map((todo) => ({ ...todo }));
  }

  formatForPrompt(): string {
    if (this.todos.length === 0) {
      return "当前没有计划步骤。";
    }

    return this.todos
      .map((todo) => `[${todo.status}] #${todo.id} ${todo.description}`)
      .join("\n");
  }

  reset(): void {
    this.todos = [];
  }
}

export const todoManager = new TodoManager();

export function isTodoStatus(value: unknown): value is TodoStatus {
  return (
    typeof value === "string" && TODO_STATUSES.includes(value as TodoStatus)
  );
}

export function resetTodoManagerForTests(): void {
  todoManager.reset();
}
