import * as THREE from 'three';
import {cloneDeep} from 'lodash';

import { loadModel, Model } from '../model';
import AnimState from '../model/anim/AnimState';
import { AnimType } from './data/animType';
import { angleToRad, angleTo, getDistanceLba, WORLD_SCALE, distance2D } from '../utils/lba';
import {createBoundingBox} from '../utils/rendering';
import { loadSprite } from './scenery/isometric/sprites';

import { getObjectName } from '../ui/editor/DebugData';
import { createActorLabel } from '../ui/editor/labels';
import { runScript } from './scripting';
import { compileScripts } from '../scripting/compiler';
import { parseScript } from '../scripting/parser';
import { postProcessScripts, cleanUpScripts } from '../scripting/postprocess';
import { getParams } from '../params';
import Game from './Game';
import Scene from './Scene';
import { pure } from '../utils/decorators';
import { updateHero } from './loop/hero';
import { Time } from '../datatypes';
import { getAnim } from '../model/entity';
import { processAnimAction } from './loop/animAction';
import { computeWagonMovement, WagonState, initWagonState } from './gameplay/wagon';
import Extra, { getBonus } from './Extra';

interface ActorFlags {
    hasCollisions: boolean;
    hasCollisionBricks: boolean;
    hasCollisionBricksLow: boolean;
    hasCollisionFloor: boolean;
    hasSpriteAnim3D: boolean;
    isVisible: boolean;
    isSprite: boolean;
    canFall: boolean;
    canCarryActor: boolean;
    noShadow: boolean;
    canBePushed: boolean;
}

export interface ActorProps {
    index: number;
    sceneIndex: number;
    pos: [number, number, number];
    life: number;
    flags: ActorFlags;
    entityIndex: number;
    bodyIndex: number;
    animIndex: number;
    dirMode: number;
    angle: number;
    speed: number;
    spriteIndex: number;
    spriteAnim3DNumber: number;
    lifeScriptSize: number;
    lifeScript: DataView;
    moveScriptSize: number;
    moveScript: DataView;
    textColor: string;
    prevEntityIndex?: number;
    prevAnimIndex?: number;
    prevAngle?: number;
    followActor?: number;
    extraType: number;
    extraAmount: number;
}

interface ActorPhysics {
    position: THREE.Vector3;
    orientation: THREE.Quaternion;
    temp: {
        position: THREE.Vector3;
        destination: THREE.Vector3;
        angle: number;
        destAngle: number;
        doorPosition?: [number, number, number];
    };
    carried: {
        position: THREE.Vector3;
        orientation: THREE.Quaternion;
    };
}

export interface ActorState {
    isVisible: boolean;
    isDead: boolean;
    isFalling: boolean;
    isSliding: boolean;
    isStuck: boolean;
    hasGravityByAnim: boolean;
    isJumping: boolean;
    jumpStartHeight: number;
    isWalking: boolean;
    isTurning: boolean;
    isFighting: boolean;
    isHit: boolean;
    wasHitBy: number;
    hasSeenHit: boolean;
    repeatHit: number;
    isCarried: boolean;
    isCarriedBy: number;
    isSwitchingHit: boolean;
    isCrouching: boolean;
    isClimbing: boolean;
    isColliding: boolean;
    isDrowning: boolean;
    isDrowningLava: boolean;
    isDrowningStars: boolean;
    isTouchingGround: boolean;
    isTouchingFloor: boolean;
    isUsingProtoOrJetpack: boolean;
    isSearching: boolean;
    isToppingOutUp: boolean;
    isDrawingSword: boolean;
    distFromGround: number;
    distFromFloor: number;
    fallDistance: number;
    hasCollidedWithActor: number;
    floorSound: number;
    floorSound2: number;
    nextAnim: number;
}

export enum SlideWay {
    FORWARD,
    BACKWARD
}

interface SlideState {
    startTime: number;
    startPos: THREE.Vector3;
    direction: THREE.Vector3;
    way: SlideWay;
}

interface ActorScripts {
    life: any;
    move: any;
}

interface NewActorDetails {
    position: THREE.Vector3;
    props: {
        entityIndex: number;
        bodyIndex: number;
        animIndex: number;
    };
}

export const ActorDirMode = {
    NO_MOVE: 0,
    MANUAL: 1,
    FOLLOW: 2,
    TRACK: 3,
    FOLLOW2: 4,
    TRACK_ATTACK: 5,
    SAME_XZ: 6,
    PINGUIN: 7,
    WAGON: 8,
    MOVE_CIRCLE: 9,
    MOVE_CIRCLE2: 10,
    SAME_XZ_BETA: 11,
    MOVE_BUGGY: 12,
    MOVE_BUGGY_MANUAL: 13
};

const G = new THREE.Object3D();
const P = new THREE.Vector3(0, 0, 0);

export default class Actor {
    readonly type: string = 'actor';
    readonly index: number;
    readonly props: ActorProps;
    readonly state: ActorState;
    readonly sound: any;
    readonly soundVoice: any;
    private readonly game: Game;
    private readonly scene: Scene;
    animState: AnimState = null;
    slideState: SlideState;
    threeObject?: THREE.Object3D = null;
    model?: Model = null;
    sprite?: any = null;
    physics: ActorPhysics = null;
    scripts: ActorScripts;
    // Those properties are used by the editor.
    // We should move them somewhere else.
    label?: any;
    refreshLabel?: Function;
    wagonState?: WagonState;
    /**
     * This is used to add data meant to be looked
     * at in the inspector for debugging purposes.
     */
    dbg: any = {};

    static async load(
        game: Game,
        scene: Scene,
        props: ActorProps,
    ): Promise<Actor> {
        const actor = new Actor(game, scene, props);
        if (actor.animState) {
            await actor.loadMesh();
        }
        return actor;
    }

    // This function is used for creating new
    // actors at runtime (ex: in the editor)
    static async create(
        game: Game,
        scene: Scene,
        details: NewActorDetails
    ): Promise<Actor> {
        const props = createNewActorProps(scene, details);
        const actor = await Actor.load(game, scene, props);
        // This is usually called in 3 phases on all actors
        // at scene load time. See loadScripts() function.
        postProcessScripts(scene, actor);
        cleanUpScripts(actor);
        compileScripts(game, scene, actor);
        return actor;
    }

    private constructor(
        game: Game,
        scene: Scene,
        props: ActorProps
    ) {
        this.index = props.index;
        this.game = game;
        this.scene = scene;
        this.props = cloneDeep(props);
        this.physics = initPhysics(props);
        this.state = Actor.createState();
        this.state.isVisible = props.flags.isVisible
            && (props.life > 0 || props.bodyIndex >= 0);
        // Do Meca Pinguin checks for both games correctly
        if (getParams().game === 'lba2' && props.index === 1 ||
            getParams().game === 'lba1' && props.entityIndex === 9) {
            this.state.isVisible = false;
        }
        this.scripts = {
            life: parseScript(props.index, 'life', props.lifeScript),
            move: parseScript(props.index, 'move', props.moveScript)
        };
        const skipModel = scene.isSideScene && this.index === 0;
        if (!skipModel) {
            this.animState = new AnimState();
        }

        if (this.game.getState().config.positionalAudio) {
            const audio = this.game.getAudioManager();
            if (this.index !== 0) {
                this.sound = audio.createSamplePositionalAudio();
                this.soundVoice = audio.createSamplePositionalAudio();
                // this.soundVoice.setDirectionalCone(90, 120, 0.3);
            } else {
                this.sound = audio.createSampleAudio();
                this.soundVoice = audio.createSampleAudio();
            }
        }

        if (props.dirMode === ActorDirMode.WAGON) {
            this.wagonState = initWagonState(angleToRad(props.angle));
        }
        this.slideState = {
            startTime: 0,
            startPos: new THREE.Vector3(),
            direction: new THREE.Vector3(),
            way: SlideWay.FORWARD
        };
    }

    update(game: Game, scene: Scene, time: any) {
        if (this.state.isDead)
            return;

        if (this.state.nextAnim !== null) {
            this.setAnim(this.state.nextAnim);
            this.state.nextAnim = null;
        }

        this.runScripts(time);

        // Don't update the actor if someone else is talking.
        const currentTalkingActor = game.getState().actorTalking;
        if (currentTalkingActor > -1 && currentTalkingActor !== this.index &&
            !(game.vr && game.controlsState.firstPerson)) {
            return;
        }

        if (this.model !== null
            && this.threeObject
            && (this.threeObject.visible || this.index === 0)) {
            const model = this.model;
            model.matrixRotation.makeRotationFromQuaternion(this.physics.orientation);
            this.updateModel(
                game,
                scene,
                model,
                time
            );
            const firstPerson = game.controlsState.firstPerson
                && scene.isActive
                && this.index === 0;
            const behaviour = game.getState().hero.behaviour;
            this.updateMovements(firstPerson, behaviour, time);
        }
        if (this.sprite) {
            this.sprite.update(time);
        }

        if (this.props.dirMode === ActorDirMode.SAME_XZ) {
            const { followActor } = this.props;
            if (followActor > -1) {
                const targetActor = scene.actors[followActor];
                const { x, z } = targetActor.physics.position;
                const y = this.physics.position.y;
                this.physics.position.set(x, y, z);
                this.threeObject.quaternion.copy(targetActor.physics.orientation);
                this.threeObject.position.copy(this.physics.position);
            }
        }

        if (this.props.dirMode === ActorDirMode.FOLLOW) {
            const { followActor } = this.props;
            if (followActor > -1) {
                if (this.props.flags.isSprite) {
                    this.gotoSprite(
                        scene.actors[followActor].physics.position,
                        time.delta * WORLD_SCALE * this.props.speed / 5
                    );
                } else {
                    this.goto(scene.actors[followActor].physics.position);
                }
            }
        }

        if (this.props.dirMode === ActorDirMode.WAGON) {
            computeWagonMovement(scene, this, time);
        }

        if (scene.isActive && this.index === 0) {
            updateHero(game, scene, this, time);
        }
    }

    updateMovements(firstPerson: boolean, behaviour: number, time: any) {
        const deltaMS = time.delta * 1000;
        if (this.state.isTurning) {
            // We want to rotate in the most efficient way possible, i.e. we rotate
            // either clockwise or anticlockwise depening on which one is fastest.
            let distanceAnticlockwise;
            let distanceClockwise;
            if (this.physics.temp.destAngle > this.physics.temp.angle) {
                distanceAnticlockwise = Math.abs(this.physics.temp.destAngle -
                                                 this.physics.temp.angle);
                distanceClockwise = 2 * Math.PI - distanceAnticlockwise;
            } else {
                distanceClockwise = Math.abs(this.physics.temp.destAngle -
                                             this.physics.temp.angle);
                distanceAnticlockwise =  2 * Math.PI - distanceClockwise;
            }
            const baseAngle = Math.min(distanceAnticlockwise,
                                       distanceClockwise) * deltaMS;
            const angle = (this.props.speed > 0) ? baseAngle / (this.props.speed * 10) : 0;
            const sign = distanceAnticlockwise < distanceClockwise ? 1 : -1;
            this.physics.temp.angle += sign * angle;

            if (this.physics.temp.angle < 0) {
                this.physics.temp.angle += 2 * Math.PI;
            }
            if (this.physics.temp.angle > 2 * Math.PI) {
                this.physics.temp.angle -= 2 * Math.PI;
            }

            wEuler.set(0, this.physics.temp.angle, 0, 'XZY');
            this.physics.orientation.setFromEuler(wEuler);

            if (Math.min(distanceAnticlockwise, distanceClockwise) < 0.05) {
                this.state.isTurning = false;
                this.physics.temp.destAngle = this.physics.temp.angle;
            }
        }
        if (this.state.isWalking && !(this.state.isStuck && !this.state.isJumping)) {
            this.physics.temp.position.set(0, 0, 0);

            const animIndex = this.props.animIndex;
            const useVrSteps = (firstPerson && behaviour < 4 && animIndex in vrFPsteps[behaviour]);
            const step = useVrSteps ? vrFPsteps[behaviour][animIndex] : this.animState.step;

            const speedZ = step.z * time.delta;
            const speedX = step.x * time.delta;

            this.physics.temp.position.x += Math.sin(this.physics.temp.angle) * speedZ;
            this.physics.temp.position.z += Math.cos(this.physics.temp.angle) * speedZ;

            this.physics.temp.position.x -= Math.cos(this.physics.temp.angle) * speedX;
            this.physics.temp.position.z += Math.sin(this.physics.temp.angle) * speedX;

            this.physics.temp.position.y += this.animState.step.y * time.delta;
        } else {
            this.physics.temp.position.set(0, 0, 0);
        }
    }

    updateModel(game: Game, scene: Scene, model: any, time: Time) {
        const animState = this.animState;
        const { entityIndex, animIndex } = this.props;
        animState.update(time, entityIndex, animIndex);
        if (scene.isActive) {
            const entity = model.entities[entityIndex];
            const entityAnim = getAnim(entity, animIndex);
            if (entityAnim !== null) {
                processAnimAction({
                    game,
                    scene,
                    model,
                    actor: this,
                    entityAnim,
                    animState,
                    time
                });
            }
        }
    }

    runScripts(time) {
        if (this.scripts) {
            const params = getParams();
            runScript(params, this.scripts.move, time);
            runScript(params, this.scripts.life, time);
        }
    }

    reset(scene) {
        this.resetPhysics();
        compileScripts(this.game, scene, this);
        this.state.isDead = false;
        this.state.floorSound = -1;
    }

    resetPhysics() {
        this.physics = initPhysics(this.props);
    }

    goto(position: THREE.Vector3) {
        this.physics.temp.destination = position;
        let destAngle = angleTo(this.physics.position, position);
        if (destAngle < 0) {
            destAngle += Math.PI * 2;
        }
        this.physics.temp.destAngle = destAngle;
        this.state.isWalking = true;
        this.state.isTurning = true;
        return this.getDistance(position);
    }

    gotoPosition(position: THREE.Vector3, delta: number) {
        G.position.set(0, 0, 0);
        P.set(0, 0, 0);
        P.subVectors(position, this.physics.position).normalize();
        G.translateOnAxis(P, delta);

        this.threeObject.position.add(G.position);
        this.physics.position.copy(this.threeObject.position);

        return this.physics.position.distanceTo(position);
    }

    gotoSprite(position: THREE.Vector3, delta: number) {
        this.physics.position.lerp(position, delta);
        this.threeObject.position.copy(this.physics.position);
        return this.getDistance(position);
    }

    facePoint(position: THREE.Vector3) {
        let destAngle = angleTo(this.physics.position, position);
        if (destAngle < 0) {
            destAngle += Math.PI * 2;
        }
        this.physics.temp.destAngle = destAngle;
        this.state.isTurning = true;
    }

    setAngle(angle) {
        this.state.isTurning = true;
        this.props.angle = angle;
        this.physics.temp.destAngle = angleToRad(angle);
    }

    setAngleRad(angle) {
        this.state.isTurning = true;
        this.props.angle = THREE.MathUtils.radToDeg(angle);
        this.physics.temp.destAngle = angle;
    }

    @pure()
    getDistance(pos: THREE.Vector3) {
        return this.physics.position.distanceTo(pos);
    }

    @pure()
    getDistance2D(pos: THREE.Vector3) {
        return distance2D(this.physics.position, pos);
    }

    @pure()
    getDistanceLba(pos: THREE.Vector3) {
        return getDistanceLba(this.getDistance(pos));
    }

    @pure()
    getDistanceLba2D(pos: THREE.Vector3) {
        return getDistanceLba(this.getDistance2D(pos));
    }

    stop() {
        this.state.isWalking = false;
        this.state.isTurning = false;
        this.physics.temp.destAngle = this.physics.temp.angle;
        delete this.physics.temp.destination;
        delete this.physics.temp.doorPosition;
    }

    async loadMesh() {
        const params = getParams();
        const name = getObjectName('actor',
                        this.props.sceneIndex,
                        this.props.index);
        // only if not sprite actor
        if (!this.props.flags.isSprite && this.props.bodyIndex !== 0xFF) {
            const {entityIndex, bodyIndex, animIndex} = this.props;
            const model = await loadModel(
                entityIndex,
                bodyIndex,
                animIndex,
                this.animState,
                this.scene.scenery.props.envInfo,
                this.scene.props.ambience
            );
            if (model !== null) {
                // model.mesh.visible = actor.isVisible;
                model.mesh.position.copy(this.physics.position);
                model.mesh.quaternion.copy(this.physics.orientation);
                this.model = model;
                this.threeObject = model.mesh;
                if (this.threeObject) {
                    this.threeObject.name = `actor:${name}`;
                    if (this.props.index === 0 && this.game.controlsState.firstPerson) {
                        this.threeObject.visible = false;
                    } else {
                        this.threeObject.visible = this.state.isVisible;
                    }
                }
            }
        } else {
            this.threeObject = new THREE.Object3D();
            this.threeObject.name = `actor:${name}`;
            this.threeObject.visible = this.state.isVisible;
            this.threeObject.position.copy(this.physics.position);
            this.threeObject.quaternion.copy(this.physics.orientation);
            if (this.props.flags.isSprite) {
                const {spriteIndex, flags: { hasSpriteAnim3D } } = this.props;
                const sprite = await loadSprite(
                    spriteIndex,
                    this.scene.props.ambience,
                    hasSpriteAnim3D,
                    false,
                    false
                );
                this.threeObject.add(sprite.threeObject);
                if (params.editor) {
                    sprite.boundingBoxDebugMesh = createBoundingBox(
                        sprite.boundingBox,
                        new THREE.Vector3(1, 0, 0)
                    );
                    sprite.boundingBoxDebugMesh.name = 'BoundingBox';
                    sprite.boundingBoxDebugMesh.visible = false;
                    this.threeObject.add(sprite.boundingBoxDebugMesh);
                }
                this.sprite = sprite;
            }
        }
        if (this.game.getState().config.positionalAudio) {
            const audio = this.game.getAudioManager();
            if (this.index === 0) {
                this.threeObject.add(audio.listener);
            }
            if (this.sound) {
                this.threeObject.add(this.sound);
            }
            if (this.soundVoice) {
                this.threeObject.add(this.soundVoice);
            }
        }
        if (params.editor) {
            createActorLabel(this, name, this.scene.is3DCam);
        }
    }

    setBody(scene, index) {
        if (this.props.bodyIndex === index) {
            return;
        }
        this.props.bodyIndex = index;
        this.reloadModel(scene);
    }

    setAnim(index) {
        if (this.props.animIndex === index) {
            return;
        }
        this.props.animIndex = index;
        if (this.animState.onAnimEnd) {
            this.animState.onAnimEnd();
        }
        this.animState.onAnimEnd = null;
    }

    setSprite(scene, index) {
        if (this.props.spriteIndex === index) {
            return;
        }
        this.props.spriteIndex = index;
        this.reloadModel(scene);
    }

    cancelAnims() {
        // TODO(scottwilliams): There are likely other cases where we should
        // also not cancel the animations e.g. when Twinsen is crawling. Add
        // them here when we've implemented them.
        if (this.state.isDrowning) {
            return;
        }
        this.setAnim(0);
        this.state.isJumping = false;
        this.state.isWalking = false;
        this.state.isFalling = false;
        this.state.isClimbing = false;
    }

    setAnimWithCallback(index, callback) {
        if (this.props.animIndex === index) {
            return;
        }
        this.props.animIndex = index;
        this.animState.onAnimEnd = callback;
    }

    private reloadCalls = 0;

    async reloadModel(scene: Scene) {
        this.reloadCalls += 1;
        if (this.reloadCalls > 1) {
            return;
        }
        while (this.reloadCalls > 0) {
            await this.doReloadModel(scene);
            this.reloadCalls -= 1;
        }
    }

    private async doReloadModel(scene: Scene) {
        const oldObject = this.threeObject;
        await this.loadMesh();
        scene.removeMesh(oldObject);
        scene.addMesh(this.threeObject);
        this.threeObject.updateMatrixWorld();
    }

    hit(hitBy, hitStrength) {
        if (this.sprite) {
            this.state.wasHitBy = hitBy;
            return;
        }

        let life = -1;
        // TODO(scottwilliams): This doesn't take into account actor armour.
        if (this.index === 0) {
            this.game.getState().hero.life -= hitStrength;
            life = this.game.getState().hero.life;
        } else {
            this.props.life -= hitStrength;
            life = this.props.life;
        }

        if (life <= 0) {
            // TODO(scottwilliams): This doesn't do the right thing for
            // Twinsen yet.
            this.props.life = 0;
            this.state.isDead = true;
            this.state.isVisible = false;
            if (this.threeObject) {
                this.threeObject.visible = false;
            }
            if (this.props.extraType) {
                const angle = this.physics.temp.angle - Math.PI / 2;
                Extra.bonus(
                    this.game,
                    this.scene,
                    this.physics.position,
                    angle,
                    getBonus(this.props.extraType),
                    this.props.extraAmount,
                    this.game.getTime(),
                );
            }
            return;
        }

        // Ensure we don't repeatedly play the hit animation.
        if (this.state.isHit &&
            this.props.animIndex === AnimType.HIT) {
            return;
        }

        const currentAnim = this.props.animIndex;
        this.setAnimWithCallback(AnimType.HIT, () => {
            if (this.index !== 0 && this.props.animIndex === AnimType.HIT) {
                this.state.nextAnim = currentAnim;
            }
            this.state.isHit = false;
        });
        this.state.isHit = true;
        this.state.wasHitBy = hitBy;
    }

    playSample(index: number, frequency: number = 0x1000, loopCount: number = 0) {
        const audio = this.game.getAudioManager();
        if (this.game.getState().config.positionalAudio) {
            audio.playSound(this.sound, index, frequency, loopCount);
            return;
        }
        if (audio.isPlayingSampleForActor(this.index, index)) {
            // Don't play the sample again if this actor is already playing it.
            return;
        }
        audio.playSample(index, frequency, loopCount, this.index);
    }

    stopSample(index?: number) {
        const audio = this.game.getAudioManager();
        if (this.game.getState().config.positionalAudio) {
            audio.stopSound(this.sound, index);
            return;
        }
        audio.stopSample(index);
    }

    stopSamples() {
        this.game.getAudioManager().stopSamplesForActor(this.index);
    }

    setSampleVolume(volume: number) {
        if (this.game.getState().config.positionalAudio) {
            this.sound.setVolume(volume);
        }
    }

    playVoice(index: number, textBankId: number, onEndedCallback = null) {
        const audio = this.game.getAudioManager();
        if (this.game.getState().config.positionalAudio) {
            audio.playSoundVoice(this.soundVoice, index, textBankId, onEndedCallback);
            return;
        }
        audio.playVoice(index, textBankId, onEndedCallback);
    }

    stopVoice() {
        const audio = this.game.getAudioManager();
        if (this.game.getState().config.positionalAudio) {
            audio.stopSound(this.soundVoice);
            return;
        }
        audio.stopVoice();
    }

    getBoundingBox() {
        return this.model ? this.model?.boundingBox : this.sprite?.boundingBox;
    }

    private static createState(): ActorState {
        return {
            isVisible: false,
            isDead: false,
            isFalling: false,
            isSliding: false,
            isStuck: false,
            hasGravityByAnim: false,
            isJumping: false,
            jumpStartHeight: 0,
            isWalking: false,
            isTurning: false,
            isFighting: false,
            isHit: false,
            wasHitBy: -1,
            hasSeenHit: false,
            repeatHit: 0,
            isCarried: false,
            isCarriedBy: -1,
            isSwitchingHit: false,
            isCrouching: false,
            isClimbing: false,
            isColliding: false,
            isDrowning: false,
            isDrowningLava: false,
            isDrowningStars: false,
            isTouchingGround: false,
            isTouchingFloor: false,
            isUsingProtoOrJetpack: false,
            isSearching: false,
            isToppingOutUp: false,
            isDrawingSword: false,
            distFromFloor: 0,
            distFromGround: 0,
            fallDistance: 0,
            hasCollidedWithActor: -1,
            floorSound: -1,
            floorSound2: -1,
            nextAnim: null,
        };
    }
}

function initPhysics({pos, angle}) {
    const angleRad = angleToRad(angle);
    const euler = new THREE.Euler(0, angleRad, 0, 'XZY');
    const orientation = new THREE.Quaternion();
    orientation.setFromEuler(euler);
    return {
        position: new THREE.Vector3(pos[0], pos[1], pos[2]),
        orientation,
        temp: {
            destination: new THREE.Vector3(0, 0, 0),
            position: new THREE.Vector3(0, 0, 0),
            angle: angleRad,
            destAngle: angleRad,
        },
        carried: {
            position: new THREE.Vector3(),
            orientation: new THREE.Quaternion(),
        },
    };
}

const wEuler = new THREE.Euler();

const slowMove = {
    [AnimType.FORWARD]: {x: 0, z: 2.5},
    [AnimType.BACKWARD]: {x: 0, z: -1.5},
    [AnimType.DODGE_LEFT]: {x: 1.5, z: 0},
    [AnimType.DODGE_RIGHT]: {x: -1.5, z: 0},
};

const fastMove = {
    [AnimType.FORWARD]: {x: 0, z: 4},
    [AnimType.BACKWARD]: {x: 0, z: -3},
    [AnimType.DODGE_LEFT]: {x: 2, z: 0},
    [AnimType.DODGE_RIGHT]: {x: -2, z: 0},
};

const superSlowMove = {
    [AnimType.FORWARD]: {x: 0, z: 1.5},
    [AnimType.BACKWARD]: {x: 0, z: -0.75},
    [AnimType.DODGE_LEFT]: {x: 0.75, z: 0},
    [AnimType.DODGE_RIGHT]: {x: -0.75, z: 0},
};

const vrFPsteps = [
    slowMove,
    fastMove,
    slowMove,
    superSlowMove
];

export function createNewActorProps(
    scene: Scene,
    details: NewActorDetails
): ActorProps {
    return {
        ...details.props,
        sceneIndex: scene.index,
        index: scene.actors.length,
        pos: details.position.toArray() as any,
        life: 255,
        flags: {
            hasCollisions: true,
            hasCollisionBricks: true,
            hasCollisionBricksLow: true,
            hasCollisionFloor: true,
            hasSpriteAnim3D: false,
            canFall: true,
            canCarryActor: false,
            isVisible: true,
            isSprite: false,
            noShadow: false,
            canBePushed: false,
        },
        dirMode: ActorDirMode.NO_MOVE,
        angle: 0,
        speed: 35,
        spriteIndex: 0,
        spriteAnim3DNumber: -1,
        lifeScriptSize: 1,
        lifeScript: new DataView(new ArrayBuffer(1)),
        moveScriptSize: 1,
        moveScript: new DataView(new ArrayBuffer(1)),
        textColor: 'white',
        extraType: 0,
        extraAmount: 0
    };
}
