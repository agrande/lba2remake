import * as THREE from 'three';

import { getRandom, getHtmlColor } from '../utils/lba';
import { SpriteType } from './data/spriteType';
import SampleType from './data/sampleType';
import { loadSprite } from './scenery/isometric/sprites';
import { clone } from 'lodash';
import { MAX_LIFE } from './GameState';
import Scene from './Scene';
import Game from './Game';
import { Time } from '../datatypes';
import { getParams } from '../params';
import { loadInventoryModel } from '../model/inventory';
// import { createBoundingBox } from '../utils/rendering';

export const ExtraFlag = {
    TIME_OUT: 1 << 0,
    FLY: 1 << 1,
    END_OBJ: 1 << 2,
    END_COL: 1 << 3,
    STOP_COL: 1 << 4,
    TAKABLE: 1 << 5,
    FLASH: 1 << 6,
    AIM: 1 << 7,
    IMPACT: 1 << 8,
    TIME_IN: 1 << 10,
    WAIT_NO_COL: 1 << 13,
    BONUS: 1 << 14,
    DART: 1 << 16,
};

interface ExtraProps {
    bonus: number;
    flags: {
        hasCollisions: boolean;
        hasCollisionFloor: boolean;
        hasCollisionBricks: boolean;
        canFall: boolean;
        isVisible: boolean;
        isSprite: boolean;
    };
}

interface ExtraState {
    isVisible: boolean;
    isTouchingGround: boolean;
    isTouchingFloor: boolean;
    isDead: boolean;
    isColliding: boolean;
    distFromGround: number;
    distFromFloor: number;
}

interface ExtraPhysics {
    position: THREE.Vector3;
    orientation: THREE.Quaternion;
    temp: {
        position: THREE.Vector3,
        angle: number,
        destAngle: number
        direction: THREE.Vector3,
        velocity: THREE.Vector3,
    };
}

let indexCount = 0;
const ACTOR_BOX = new THREE.Box3();
const EXTRA_BOX = new THREE.Box3();
const INTERSECTION = new THREE.Box3();
const DIFF = new THREE.Vector3();

const TOUCH_GROUND = new THREE.Vector3(0, 0.1, 0);

const Z_AXIS = new THREE.Vector3(0, 0, 1);
const TRAJECTORY = new THREE.Vector3();
const TRAJECTORY_EULER = new THREE.Euler();
const TRAJECTORY_ROT = new THREE.Quaternion();

const G = new THREE.Object3D();
const P = new THREE.Vector3(0, 0, 0);

export default class Extra {
    readonly type = 'extra';
    readonly game: Game;
    readonly index: number;
    readonly physics: ExtraPhysics;
    readonly props: ExtraProps;
    readonly isSprite: boolean;
    readonly lifeTime: number;
    readonly baseTime: Time;
    readonly sound: any;
    readonly spriteIndex?: SpriteType;
    readonly modelIndex?: number;
    model?: any;
    info: number;
    time: Time;
    flags: number;
    state: ExtraState;
    threeObject?: THREE.Object3D;
    spawnTime: number;
    speed: number;
    weight: number;
    throwAngle: number;
    hitStrength: number;
    hasCollidedWithActor: boolean;
    throwBy: number = -1;
    targetActor: number = -1;
    /**
     * This is used to add data meant to be looked
     * at in the inspector for debugging purposes.
     */
    dbg: any = {};

    static async bonus(
        game: Game,
        scene: Scene,
        position: THREE.Vector3,
        destAngle: number,
        spriteIndex: number,
        bonus: number,
        time: Time,
    ): Promise<Extra> {
        const extra = new Extra(game, position, destAngle, time, spriteIndex, bonus);
        await extra.loadMesh(scene);
        extra.flags |= ExtraFlag.BONUS;
        extra.init(THREE.MathUtils.degToRad(75), 40, 15); // lbaToDegrees(720)
        extra.playSample(extra.sound, SampleType.BONUS_FOUND);
        scene.addExtra(extra);
        return extra;
    }

    static async throw(
        game: Game,
        scene: Scene,
        position: THREE.Vector3,
        destAngle: number,
        throwAngle: number,
        spriteIndex: number,
        bonus: number,
        time: Time,
        speed: number,
        weight: number,
        strength: number,
    ): Promise<Extra> {
        const extra = new Extra(game, position, destAngle, time, spriteIndex, bonus);
        await extra.loadMesh(scene);
        extra.flags =
              ExtraFlag.END_OBJ
            | ExtraFlag.END_COL
            | ExtraFlag.IMPACT
            | ExtraFlag.TIME_IN;
        extra.hitStrength = strength;
        extra.init(throwAngle, speed, weight);
        scene.addExtra(extra);
        return extra;
    }

    static async throwObject(
        throwBy: number,
        game: Game,
        scene: Scene,
        position: THREE.Vector3,
        destAngle: number,
        throwAngle: number,
        modelIndex: number,
        time: Time,
        speed: number,
        weight: number,
        strength: number,
    ): Promise<Extra> {
        const extra = new Extra(game, position, destAngle, time, null, null, modelIndex);
        await extra.loadMesh(scene);
        extra.throwBy = throwBy;
        extra.flags =
              ExtraFlag.END_OBJ
            | ExtraFlag.END_COL
            | ExtraFlag.IMPACT
            | ExtraFlag.TIME_IN;
        extra.hitStrength = strength;
        extra.init(throwAngle, speed, weight);
        scene.addExtra(extra);
        return extra;
    }

    static async throwAiming(
        throwBy: number,
        game: Game,
        scene: Scene,
        position: THREE.Vector3,
        destAngle: number,
        spriteIndex: number,
        time: Time,
        targetActor: number,
        speed: number,
        strength: number,
    ): Promise<Extra> {
        const extra = new Extra(game, position, destAngle, time, spriteIndex, null, null);
        await extra.loadMesh(scene);
        extra.throwBy = throwBy;
        extra.targetActor = targetActor;
        extra.flags =
              ExtraFlag.END_OBJ
            | ExtraFlag.END_COL
            | ExtraFlag.IMPACT
            | ExtraFlag.TIME_IN
            | ExtraFlag.AIM;
        extra.hitStrength = strength;
        extra.init(destAngle, speed, 1);
        scene.addExtra(extra);
        return extra;
    }

    private constructor(
        game: Game,
        position: THREE.Vector3,
        angle: number,
        time: Time,
        spriteIndex?: number,
        bonus?: number,
        modelIndex?: number,
    ) {
        this.game = game;
        this.index = indexCount;
        indexCount += 1;
        this.physics = {
            position,
            orientation: new THREE.Quaternion(),
            temp: {
                position: position.clone(),
                angle,
                destAngle: angle,
                direction: position.clone(),
                velocity: position.clone(),
            }
        };
        const euler = new THREE.Euler(0, angle, 0, 'XZY');
        this.physics.orientation.setFromEuler(euler);
        this.isSprite = spriteIndex !== null;
        this.modelIndex = modelIndex;
        this.hasCollidedWithActor = false;
        this.flags = ExtraFlag.STOP_COL
            | ExtraFlag.WAIT_NO_COL
            | ExtraFlag.BONUS
            | ExtraFlag.TAKABLE
            | ExtraFlag.TIME_IN;
        this.props = {
            bonus,
            flags: {
                hasCollisions: true,
                hasCollisionFloor: true,
                hasCollisionBricks: true,
                canFall: true,
                isVisible: true,
                isSprite: true,
            }
        };
        this.model = {
            boundingBox: new THREE.Box3(
                new THREE.Vector3(-0.1, -0.1, -0.1),
                new THREE.Vector3(0.1, 0.1, 0.1),
            ),
        };
        this.state = {
            isVisible: true,
            isTouchingGround: false,
            isTouchingFloor: false,
            isDead: false,
            isColliding: false,
            distFromGround: 0,
            distFromFloor: 0,
        };
        this.spriteIndex = spriteIndex;
        this.spawnTime = 0;
        this.lifeTime = 20; // 20 seconds
        this.info = bonus;
        this.hitStrength = 0;
        this.time = time;
        this.baseTime = time;
        this.spawnTime = time.elapsed;
        this.speed = 0;
        this.weight = 0;

        if (game.getState().config.positionalAudio) {
            const audio = game.getAudioManager();
            this.sound = audio.createSamplePositionalAudio();
        }
    }

    private async loadMesh(scene: Scene) {
        this.threeObject = new THREE.Object3D();
        this.threeObject.position.copy(this.physics.position);

        TRAJECTORY_EULER.setFromQuaternion(this.physics.orientation, 'YXZ');
        TRAJECTORY_EULER.y += Math.PI / 2;
        this.threeObject.quaternion.setFromEuler(TRAJECTORY_EULER);

        let obj = null;
        if (this.isSprite) {
            obj = await loadSprite(
                this.spriteIndex,
                scene.props.ambience,
                false,
                true,
                scene.is3DCam
            );
        } else {
            obj = await loadInventoryModel(
                {},
                this.modelIndex,
                scene.scenery.props.envInfo,
                scene.props.ambience
            );
        }

        // // Debug Bounding Box
        // obj.boundingBoxDebugMesh = createBoundingBox(
        //     obj.boundingBox,
        //     new THREE.Vector3(1, 0, 0)
        // );
        // obj.boundingBoxDebugMesh.name = 'BoundingBox';
        // this.threeObject.add(obj.boundingBoxDebugMesh);

        this.threeObject.add(obj.threeObject ?? obj.mesh);
        this.threeObject.name = `extra_${this.props.bonus}`;
        this.threeObject.visible = this.state.isVisible;
        this.model = obj;
        if (scene.game.getState().config.positionalAudio) {
            this.threeObject.add(this.sound);
        }
    }

    private init(angle, speed, _weight) {
        this.flags |= ExtraFlag.FLY;
        this.time = this.baseTime;
        this.speed = speed;
        this.weight = _weight;
        this.throwAngle = angle;

        if (!((this.flags & ExtraFlag.AIM) === ExtraFlag.AIM)) {
            this.doTrajectory(this.time);
        }
    }

    playSample(sound: any, index: number) {
        const audio = this.game.getAudioManager();
        if (this.game.getState().config.positionalAudio) {
            audio.playSound(sound, index);
            return;
        }
        audio.playSample(index);
    }

    stopSample(sound: any, index: number) {
        const audio = this.game.getAudioManager();
        if (this.game.getState().config.positionalAudio) {
            audio.stopSound(sound, index);
            return;
        }
        audio.stopSample(index);
    }

    doTrajectory(time) {
        const ts = (time.elapsed - this.spawnTime) * 0.002;
        const gravity = 0.9 * Math.pow(1.275, this.weight) * 1000;
        const x = this.speed * ts * Math.cos(this.throwAngle);
        const y = this.speed * ts * Math.sin(this.throwAngle) - (0.5 * gravity * ts * ts);

        TRAJECTORY.set(x, y, 0);
        TRAJECTORY_EULER.set(0, this.physics.temp.angle, 0, 'XZY');
        TRAJECTORY.applyEuler(TRAJECTORY_EULER);

        this.physics.position.add(TRAJECTORY);
        this.threeObject.position.copy(this.physics.position);
        this.threeObject.quaternion.copy(
            TRAJECTORY_ROT.setFromUnitVectors(
                Z_AXIS,
                TRAJECTORY.normalize(),
            ),
        );
    }

    doAiming(scene, time) {
        const delta = this.speed * time.delta * 0.001;

        const aimingActor = scene.actors[this.targetActor];
        const bb = aimingActor.getBoundingBox();
        const halfHeight = (bb.max.y - bb.min.y) * 0.5;

        const position = aimingActor.physics.position.clone();
        position.y += halfHeight;

        G.position.set(0, 0, 0);
        P.set(0, 0, 0);
        P.subVectors(position, this.physics.position).normalize();
        G.translateOnAxis(P, delta);

        this.threeObject.position.add(G.position);
        this.physics.position.copy(this.threeObject.position);
    }

    update(game: Game, scene: Scene, time: Time) {
        let hitActor = null;

        if (time.elapsed - this.spawnTime > this.lifeTime
            && this.spriteIndex !== SpriteType.KEY) {
            this.flags |= ExtraFlag.TIME_OUT;
        }

        if ((this.flags & ExtraFlag.FLY) === ExtraFlag.FLY) {
            if ((this.flags & ExtraFlag.AIM) === ExtraFlag.AIM) {
                this.doAiming(scene, time);
            } else {
                this.doTrajectory(time);
            }
        }

        if (this.model &&
            !((this.flags & ExtraFlag.FLY) === ExtraFlag.FLY) ||
            ((this.flags & ExtraFlag.IMPACT) === ExtraFlag.IMPACT)) {
            EXTRA_BOX.copy(this.model.boundingBox);
            EXTRA_BOX.translate(this.physics.position);
            DIFF.set(0, 1 / 128, 0);
            EXTRA_BOX.translate(DIFF);
            for (let i = 0; i < scene.actors.length; i += 1) {
                const a = scene.actors[i];
                if ((a.model === null && a.sprite === null)
                    || i === this.throwBy
                    || a.state.isDead
                    || !(a.props.flags.hasCollisions || a.props.flags.isSprite)) {
                    continue;
                }
                const boundingBox = a.getBoundingBox();
                INTERSECTION.copy(boundingBox);
                if (a.model) {
                    INTERSECTION.translate(a.physics.position);
                } else {
                    INTERSECTION.applyMatrix4(a.threeObject.matrixWorld);
                }
                DIFF.set(0, 1 / 128, 0);
                INTERSECTION.translate(DIFF);
                ACTOR_BOX.copy(INTERSECTION);
                if (ACTOR_BOX.intersectsBox(EXTRA_BOX)) {
                    hitActor = a;
                    break;
                }
            }
        }

        // Only Twinsen can collect extras such as keys, but we allow other actors
        // to collect extras like life points.
        let shouldCollect = false;

        if (hitActor && hitActor.index === 0) {
            shouldCollect = true;
            if (((this.flags & ExtraFlag.BONUS) === ExtraFlag.BONUS)) {
                const { hero } = game.getState();
                switch (this.spriteIndex) {
                    case SpriteType.LIFE:
                        hero.life += this.info * 5;
                        if (hero.life > MAX_LIFE) {
                            hero.life = MAX_LIFE;
                        }
                        break;
                    case SpriteType.MAGIC:
                        hero.magic += this.info;
                        if (hero.magic > (hero.magicball.level + 1) * 20) {
                            hero.magic = (hero.magicball.level + 1) * 20;
                        }
                        break;
                    case SpriteType.KEY:
                        hero.keys += 1;
                        this.info = 1;
                        break;
                    case SpriteType.MONEY:
                    case SpriteType.KASHES:
                        hero.money += this.info;
                        break;
                }
            }
            if (((this.flags & ExtraFlag.IMPACT) === ExtraFlag.IMPACT)) {
                hitActor.hit(-1, this.hitStrength); // check hitBy is correct
            }
        } else if (hitActor) {
            switch (this.spriteIndex) {
                case SpriteType.LIFE:
                    hitActor.props.life += this.info * 5;
                    shouldCollect = true;
                    break;
            }
        }

        if (this.props.flags.hasCollisions &&
            time.elapsed - this.spawnTime > 0.5) {
            const isTouchingGroud = scene.scenery.physics.processCollisions(scene, this, time);
            if (isTouchingGroud) {
                this.physics.position.add(TOUCH_GROUND);
                this.threeObject.position.copy(this.physics.position);
                this.flags &= ~ExtraFlag.FLY;
                if ((this.flags & ExtraFlag.IMPACT) === ExtraFlag.IMPACT) {
                    scene.removeExtra(this);
                }
            }
            if (this.state.isColliding && (this.flags & ExtraFlag.DART) === ExtraFlag.DART) {
                this.flags &= ~ExtraFlag.FLY;
            }
        }

        if (shouldCollect ||
            (this.flags & ExtraFlag.TIME_OUT) === ExtraFlag.TIME_OUT &&
            !((this.flags & ExtraFlag.DART) === ExtraFlag.DART)) {
            if (this.info && shouldCollect) {
                this.collect(game, scene);
            }
            scene.removeExtra(this);
        }
    }

    private collect(game: Game, scene: Scene) {
        this.stopSample(this.sound, SampleType.BONUS_FOUND);
        this.playSample(this.sound, SampleType.BONUS_COLLECTED);
        const itrjId = `extra_${this.index}_${this.info}`;
        const interjections = clone(game.getUiState().interjections);

        interjections[itrjId] = {
            scene: scene.index,
            obj: this,
            color: getHtmlColor(scene.props.palette, (10 * 16) + 12),
            value: this.info,
        };
        game.setUiState({interjections});
        setTimeout(() => {
            const interjectionsCopy = clone(game.getUiState().interjections);
            delete interjectionsCopy[itrjId];
            game.setUiState({interjections: interjectionsCopy});
        }, 1000);
    }

    collectKey(game: Game, scene: Scene) {
        game.getState().hero.keys += 1;
        this.info = 1;
        this.collect(game, scene);
        scene.removeExtra(this);
    }

    getBoundingBox() {
        return this.model.boundingBox;
    }
}

export function getBonus(type): SpriteType {
    const isLBA1 = getParams().game === 'lba1';
    const bonus = [];
    for (let b = 0; b < 5; b += 1) {
        if (type & (1 << (b + 4))) {
            bonus.push(b);
        }
    }

    // TODO validate per chapter bonus

    let spriteIndex = bonus[getRandom(0, bonus.length - 1)];
    spriteIndex += 3;

    if (!isLBA1 && spriteIndex === 3) {
        spriteIndex = SpriteType.KASHES;
        // TODO if planet Zeelich then increment
        // spriteIndex += 1
    }

    return spriteIndex;
}
