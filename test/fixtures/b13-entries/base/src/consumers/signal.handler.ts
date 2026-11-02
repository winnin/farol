import type { TriageUseCase } from '../use-cases/triage.use-case'

export function createSignalHandler(useCase: TriageUseCase) {
  return async (message: string) => {
    await useCase.execute(message)
  }
}
