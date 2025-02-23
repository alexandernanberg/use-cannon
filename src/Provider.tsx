import React, { useState, useLayoutEffect, useRef, useMemo, useCallback } from 'react'
import { useThree, useFrame } from '@react-three/fiber'
import { InstancedMesh, Vector3, Quaternion, Matrix4 } from 'three'

import type { Shape } from 'cannon-es'
import type { Object3D } from 'three'

import { context } from './setup'

// @ts-expect-error Types are not setup for this yet
import CannonWorker from '../src/worker'
import { useUpdateWorldPropsEffect } from './useUpdateWorldPropsEffect'

import type { AtomicName, Buffers, PropValue, Refs, ProviderContext } from './setup'
import type { Triplet } from './hooks'

function noop() {
  /**/
}

export type Broadphase = 'Naive' | 'SAP'

export type ProviderProps = {
  children: React.ReactNode
  shouldInvalidate?: boolean

  tolerance?: number
  step?: number
  iterations?: number

  allowSleep?: boolean
  broadphase?: Broadphase
  gravity?: Triplet
  quatNormalizeFast?: boolean
  quatNormalizeSkip?: number
  solver?: 'GS' | 'Split'

  axisIndex?: number
  defaultContactMaterial?: {
    friction?: number
    restitution?: number
    contactEquationStiffness?: number
    contactEquationRelaxation?: number
    frictionEquationStiffness?: number
    frictionEquationRelaxation?: number
  }
  size?: number
}

type Observation = { [K in AtomicName]: [id: number, value: PropValue<K>, type: K] }[AtomicName]

type WorkerFrameMessage = {
  data: Buffers & {
    op: 'frame'
    observations: Observation[]
    active: boolean
    bodies?: string[]
  }
}

export type WorkerCollideEvent = {
  data: {
    op: 'event'
    type: 'collide'
    target: string
    body: string
    contact: {
      id: string
      ni: number[]
      ri: number[]
      rj: number[]
      impactVelocity: number
      bi: string
      bj: string
      /** Contact point in world space */
      contactPoint: number[]
      /** Normal of the contact, relative to the colliding body */
      contactNormal: number[]
    }
    collisionFilters: {
      bodyFilterGroup: number
      bodyFilterMask: number
      targetFilterGroup: number
      targetFilterMask: number
    }
  }
}

export type WorkerRayhitEvent = {
  data: {
    op: 'event'
    type: 'rayhit'
    ray: {
      from: number[]
      to: number[]
      direction: number[]
      collisionFilterGroup: number
      collisionFilterMask: number
      uuid: string
    }
    hasHit: boolean
    body: string | null
    shape: (Omit<Shape, 'body'> & { body: string }) | null
    rayFromWorld: number[]
    rayToWorld: number[]
    hitNormalWorld: number[]
    hitPointWorld: number[]
    hitFaceIndex: number
    distance: number
    shouldStop: boolean
  }
}
export type WorkerCollideBeginEvent = {
  data: {
    op: 'event'
    type: 'collideBegin'
    bodyA: string
    bodyB: string
  }
}
export type WorkerCollideEndEvent = {
  data: {
    op: 'event'
    type: 'collideEnd'
    bodyA: string
    bodyB: string
  }
}
type WorkerEventMessage =
  | WorkerCollideEvent
  | WorkerRayhitEvent
  | WorkerCollideBeginEvent
  | WorkerCollideEndEvent
type IncomingWorkerMessage = WorkerFrameMessage | WorkerEventMessage

const v = new Vector3()
const s = new Vector3(1, 1, 1)
const q = new Quaternion()
const m = new Matrix4()

function apply(index: number, buffers: Buffers, object?: Object3D) {
  if (index !== undefined) {
    m.compose(
      v.fromArray(buffers.positions, index * 3),
      q.fromArray(buffers.quaternions, index * 4),
      object ? object.scale : s,
    )
    if (object) {
      object.matrixAutoUpdate = false
      object.matrix.copy(m)
    }
    return m
  }
  return m.identity()
}

export default function Provider({
  children,
  shouldInvalidate = true,
  step = 1 / 60,
  gravity = [0, -10, 0],
  tolerance = 0.001,
  iterations = 5,
  allowSleep = false,
  broadphase = 'Naive',
  axisIndex = 0,
  quatNormalizeFast = false,
  quatNormalizeSkip = 0,
  solver = 'GS',
  defaultContactMaterial = { contactEquationStiffness: 1e6 },
  size = 1000,
}: ProviderProps): JSX.Element {
  const { invalidate } = useThree()
  const [worker] = useState<Worker>(() => new CannonWorker() as Worker)
  const [refs] = useState<Refs>({})
  const [buffers] = useState<Buffers>(() => ({
    positions: new Float32Array(size * 3),
    quaternions: new Float32Array(size * 4),
  }))
  const [events] = useState<ProviderContext['events']>({})
  const [subscriptions] = useState<ProviderContext['subscriptions']>({})

  const bodies = useRef<{ [uuid: string]: number }>({})
  const loop = useCallback(() => {
    if (buffers.positions.byteLength !== 0 && buffers.quaternions.byteLength !== 0) {
      worker.postMessage({ op: 'step', ...buffers }, [buffers.positions.buffer, buffers.quaternions.buffer])
    }
  }, [])

  // Run loop *after* all the physics objects have ran theirs!
  // Otherwise the buffers will be invalidated by the browser
  useFrame(loop)

  useLayoutEffect(() => {
    worker.postMessage({
      op: 'init',
      props: {
        gravity,
        tolerance,
        step,
        iterations,
        broadphase,
        allowSleep,
        axisIndex,
        defaultContactMaterial,
        quatNormalizeFast,
        quatNormalizeSkip,
        solver,
      },
    })

    let i = 0
    let body: string
    let callback
    worker.onmessage = (e: IncomingWorkerMessage) => {
      switch (e.data.op) {
        case 'frame':
          buffers.positions = e.data.positions
          buffers.quaternions = e.data.quaternions
          if (e.data.bodies) {
            for (i = 0; i < e.data.bodies.length; i++) {
              body = e.data.bodies[i]
              bodies.current[body] = e.data.bodies.indexOf(body)
            }
          }

          e.data.observations.forEach(([id, value, type]) => {
            const subscription = subscriptions[id] || {}
            callback = subscription[type] || noop
            // HELP: We clearly know the type of the callback, but typescript can't deal with it
            callback(value as never)
          })

          if (e.data.active) {
            for (const ref of Object.values(refs)) {
              if (ref instanceof InstancedMesh) {
                for (let i = 0; i < ref.count; i++) {
                  const index = bodies.current[`${ref.uuid}/${i}`]
                  if (index !== undefined) {
                    ref.setMatrixAt(i, apply(index, buffers))
                  }
                  ref.instanceMatrix.needsUpdate = true
                }
              } else {
                apply(bodies.current[ref.uuid], buffers, ref)
              }
            }
            if (shouldInvalidate) {
              invalidate()
            }
          }

          break
        case 'event':
          switch (e.data.type) {
            case 'collide':
              callback = events[e.data.target]?.collide || noop
              callback({
                ...e.data,
                target: refs[e.data.target],
                body: refs[e.data.body],
                contact: {
                  ...e.data.contact,
                  bi: refs[e.data.contact.bi],
                  bj: refs[e.data.contact.bj],
                },
              })
              break
            case 'collideBegin':
              callback = events[e.data.bodyA]?.collideBegin || noop
              callback({
                op: 'event',
                type: 'collideBegin',
                target: refs[e.data.bodyA],
                body: refs[e.data.bodyB],
              })
              callback = events[e.data.bodyB]?.collideBegin || noop
              callback({
                op: 'event',
                type: 'collideBegin',
                target: refs[e.data.bodyB],
                body: refs[e.data.bodyA],
              })
              break
            case 'collideEnd':
              callback = events[e.data.bodyA]?.collideEnd || noop
              callback({
                op: 'event',
                type: 'collideEnd',
                target: refs[e.data.bodyA],
                body: refs[e.data.bodyB],
              })
              callback = events[e.data.bodyB]?.collideEnd || noop
              callback({
                op: 'event',
                type: 'collideEnd',
                target: refs[e.data.bodyB],
                body: refs[e.data.bodyA],
              })
              break
            case 'rayhit':
              callback = events[e.data.ray.uuid]?.rayhit || noop
              callback({
                ...e.data,
                body: e.data.body ? refs[e.data.body] : null,
              })
              break
          }
          break
      }
    }
    return () => worker.terminate()
  }, [])

  useUpdateWorldPropsEffect({ axisIndex, broadphase, gravity, iterations, step, tolerance, worker })

  const api = useMemo(
    () => ({ worker, bodies, refs, buffers, events, subscriptions }),
    [worker, bodies, refs, buffers, events, subscriptions],
  )
  return <context.Provider value={api as ProviderContext}>{children}</context.Provider>
}
