export class TriageUseCase {
  async execute(message: string): Promise<string> {
    return message.trim().toLowerCase()
  }
}
