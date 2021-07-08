import * as THREE from 'three';

import {processZones} from './zones';
import { WORLD_SIZE } from '../../utils/lba';
import Game from '../Game';
import Scene from '../Scene';
import { Time } from '../../datatypes';
import Actor, { ActorDirMode } from '../Actor';

export function processPhysicsFrame(game: Game, scene: Scene, time: Time) {
    for (const actor of scene.actors) {
        processActorPhysics(game, scene, actor, time);
    }
    for (const actor of scene.actors) {
        processCarriedPosition(scene, actor);
    }
    if (scene.isActive) {
        processZones(game, scene, time);
        processSidesceneTransitions(scene);
    }
}

function processActorPhysics(game: Game, scene: Scene, actor: Actor, time: Time) {
    if (actor.state.isDead)
        return;

    // If someone is talking who isn't this actor, don't process the physics.
    const currentTalkingActor = game.getState().actorTalking;
    if (currentTalkingActor > -1 && currentTalkingActor !== actor.index &&
        !(game.vr && game.controlsState.firstPerson)) {
        return;
    }
    if (actor.state.isCarriedBy === -1) {
        actor.physics.position.add(actor.physics.temp.position);
    }
    if (actor.props.flags.hasCollisions) {
        if (!actor.state.hasGravityByAnim &&
            (actor.props.flags.hasCollisionBricks ||
                actor.props.flags.hasCollisionFloor) &&
            actor.props.flags.canFall &&
            !actor.state.isClimbing &&
            !actor.state.isUsingProtoOrJetpack &&
            actor.props.dirMode !== ActorDirMode.WAGON) {
            // Max falling speed: 0.15m per frame
            actor.physics.position.y -= 0.25 * WORLD_SIZE * time.delta;
        }
        if (actor.props.dirMode !== ActorDirMode.WAGON) {
            scene.scenery.physics.processCollisions(scene, actor, time);
        }
        processCollisionsWithActors(scene, actor);
    }
    if (actor.state.isCarriedBy === -1) {
        actor.threeObject.quaternion.copy(actor.physics.orientation);
        actor.threeObject.position.copy(actor.physics.position);
        if (actor.model?.boundingBoxDebugMesh) {
            actor.model?.boundingBoxDebugMesh.quaternion.copy(actor.threeObject.quaternion);
            actor.model?.boundingBoxDebugMesh.quaternion.invert();
        }
    }
}

const TMP_POS = new THREE.Vector3();
const TMP_Q = new THREE.Quaternion();
const TMP_EULER = new THREE.Euler();

function processCarriedPosition(scene: Scene, actor: Actor) {
    if (actor.state.isCarriedBy === -1) {
        actor.state.isCarried = false;
        return;
    }

    const carrier = scene.actors[actor.state.isCarriedBy];
    if (!actor.state.isCarried) {
        initCarriedState(scene, actor);
    }

    const {
        position: cPosition,
        orientation: cOrientation
    } = actor.physics.carried;

    // Process the world position of actor based
    // on local position on top of the carrier object
    actor.physics.position.copy(carrier.physics.position);
    TMP_POS.copy(cPosition);
    TMP_POS.applyQuaternion(carrier.physics.orientation);
    TMP_POS.add(actor.physics.temp.position);
    actor.physics.position.add(TMP_POS);
    TMP_Q.copy(carrier.physics.orientation);
    TMP_Q.invert();
    TMP_POS.applyQuaternion(TMP_Q);
    cPosition.copy(TMP_POS);

    // Process the world rotation of actor based on
    // local orientation on top of the carrier object
    TMP_Q.multiply(cOrientation);
    TMP_Q.invert();
    actor.physics.orientation.multiply(TMP_Q);
    cOrientation.copy(carrier.physics.orientation);
    TMP_EULER.setFromQuaternion(actor.physics.orientation, 'XZY');
    actor.physics.temp.angle = TMP_EULER.y;

    actor.threeObject.quaternion.copy(actor.physics.orientation);
    actor.threeObject.position.copy(actor.physics.position);
}

function initCarriedState(scene: Scene, actor: Actor) {
    const carried = actor.physics.carried;
    const carrier = scene.actors[actor.state.isCarriedBy];
    carried.position.copy(actor.physics.position);
    carried.position.sub(carrier.physics.position);
    TMP_Q.copy(carrier.physics.orientation);
    TMP_Q.invert();
    carried.position.applyQuaternion(TMP_Q);
    carried.orientation.copy(carrier.physics.orientation);
    actor.state.isCarried = true;
}

const BB_MIN = 0.004 * WORLD_SIZE;
const BB_MAX = (WORLD_SIZE * 2) - BB_MIN;
const BOX_Y_OFFSET = 0.005 * WORLD_SIZE;

function processSidesceneTransitions(scene: Scene) {
    const hero = scene.actors[0];
    const pos = hero.physics.position.clone();
    pos.y += BOX_Y_OFFSET;
    if (scene.sideScenes && scene.props.isIsland
        && (pos.x < BB_MIN || pos.z < BB_MIN || pos.x > BB_MAX || pos.z > BB_MAX)) {
        const globalPos = new THREE.Vector3();
        globalPos.applyMatrix4(hero.threeObject.matrixWorld);
        for (const sideScene of scene.sideScenes.values()) {
            const nodePos = sideScene.sceneNode.position;
            if (globalPos.x > nodePos.x + BB_MIN
                && globalPos.x < nodePos.x + BB_MAX
                && globalPos.z > nodePos.z + BB_MIN
                && globalPos.z < nodePos.z + BB_MAX) {
                scene.goto(sideScene.index, false, false, false);
                return;
            }
        }
    }
}

const ACTOR_BOX = new THREE.Box3();
const ACTOR2_BOX = new THREE.Box3();
const INTERSECTION = new THREE.Box3();
const DIFF = new THREE.Vector3();
const ITRS_SIZE = new THREE.Vector3();
const CENTER1 = new THREE.Vector3();
const CENTER2 = new THREE.Vector3();

const YSTEP = WORLD_SIZE / 3072;
const Y_THRESHOLD = 0.000625 * WORLD_SIZE;
const H_THRESHOLD = 0.007 * WORLD_SIZE;

function processCollisionsWithActors(scene: Scene, actor: Actor) {
    actor.state.hasCollidedWithActor = -1;
    actor.state.isCarriedBy = -1;
    if (actor.state.isDead ||
        !actor.props.flags.hasCollisions ||
        actor.props.flags.isSprite
    ) {
        return;
    }
    const box = actor.getBoundingBox();
    if (!box) {
        return;
    }
    ACTOR_BOX.copy(box);

    ACTOR_BOX.translate(actor.physics.position);
    DIFF.set(0, YSTEP, 0);
    ACTOR_BOX.translate(DIFF);
    for (const otherActor of scene.actors) {
        if (otherActor.index === actor.index
            || otherActor.state.isDead
            || !otherActor.state.isVisible
            || !otherActor.props.flags.hasCollisions) {
            continue;
        }

        const boundingBox = otherActor.getBoundingBox();
        if (!boundingBox) {
            continue;
        }
        INTERSECTION.copy(boundingBox);
        if (otherActor.model) {
            INTERSECTION.translate(otherActor.physics.position);
        } else {
            INTERSECTION.applyMatrix4(otherActor.threeObject.matrixWorld);
        }
        DIFF.set(0, YSTEP, 0);
        INTERSECTION.translate(DIFF);
        ACTOR2_BOX.copy(INTERSECTION);
        if (ACTOR2_BOX.intersectsBox(ACTOR_BOX)) {
            INTERSECTION.intersect(ACTOR_BOX);
            INTERSECTION.getSize(ITRS_SIZE);
            ACTOR_BOX.getCenter(CENTER1);
            ACTOR2_BOX.getCenter(CENTER2);
            const dir = CENTER1.sub(CENTER2);
            const canCarryActor = otherActor.props.flags.canCarryActor;
            const threshold = canCarryActor ? H_THRESHOLD : Y_THRESHOLD;
            if (ACTOR_BOX.min.y < ACTOR2_BOX.max.y - threshold) {
                if (ITRS_SIZE.x < ITRS_SIZE.z) {
                    DIFF.set(ITRS_SIZE.x * Math.sign(dir.x), 0, 0);
                } else {
                    DIFF.set(0, 0, ITRS_SIZE.z * Math.sign(dir.z));
                }
            } else if (canCarryActor) {
                actor.state.distFromFloor = 0;
                actor.state.isCarriedBy = otherActor.index;
                DIFF.set(0, ITRS_SIZE.y * Math.sign(dir.y), 0);
            }
            if (!actor.props.flags.canCarryActor) {
                actor.physics.position.add(DIFF);
                ACTOR_BOX.translate(DIFF);
            }
            if (otherActor.props.flags.canBePushed) {
                otherActor.physics.position.sub(DIFF);
                otherActor.threeObject.position.sub(DIFF);
                ACTOR2_BOX.translate(DIFF);
            }
            if (actor.state.isCarriedBy !== otherActor.index
                && otherActor.state.isCarriedBy !== actor.index) {
                actor.state.hasCollidedWithActor = otherActor.index;
            }
        }
    }
}
