import { useLayoutEffect } from 'react'
import type { ProviderProps } from './Provider'
import type { CannonWorker, WorldPropName } from './setup'

type Props = Pick<Required<ProviderProps>, WorldPropName> & { worker: CannonWorker }

export function useUpdateWorldPropsEffect({
  axisIndex,
  broadphase,
  gravity,
  iterations,
  step,
  tolerance,
  worker,
}: Props) {
  useLayoutEffect(() => void worker.postMessage({ op: 'setAxisIndex', props: axisIndex }), [axisIndex])
  useLayoutEffect(() => void worker.postMessage({ op: 'setBroadphase', props: broadphase }), [broadphase])
  useLayoutEffect(() => void worker.postMessage({ op: 'setGravity', props: gravity }), [gravity])
  useLayoutEffect(() => void worker.postMessage({ op: 'setIterations', props: iterations }), [iterations])
  useLayoutEffect(() => void worker.postMessage({ op: 'setStep', props: step }), [step])
  useLayoutEffect(() => void worker.postMessage({ op: 'setTolerance', props: tolerance }), [tolerance])
}
