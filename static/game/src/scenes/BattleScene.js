import {
	SCENE_WIDTH,
	STAGE_MID_POINT,
	STAGE_PADDING,
} from '../constants/stage.js';
import {
	FighterAttackBaseData,
	FighterAttackStrength,
	FighterId,
	FighterState,
	FighterStruckDelay,
} from '../constants/fighter.js';
import { FRAME_TIME, GAME_SPEED } from '../constants/game.js';
import { Camera } from '../engine/Camera.js';
import { EntityList } from '../engine/EntityList.js';
import { Ken, Ryu } from '../entitites/fighters/index.js';
import {
	HeavyHitSplash,
	LightHitSplash,
	MediumHitSplash,
	Shadow,
} from '../entitites/fighters/shared/index.js';
import { Fireball } from '../entitites/fighters/special/Fireball.js';
import { FpsCounter } from '../entitites/overlays/FpsCounter.js';
import { StatusBar } from '../entitites/overlays/StatusBar.js';
import { KenStage } from '../entitites/stage/KenStage.js';
import { gameState, resetGameState } from '../states/gameState.js';
import { StartScene } from './StartScene.js';

export class BattleScene {
	image = document.getElementById('Winner');
	fighters = [];
	camera = undefined;
	shadows = [];
	FighterDrawOrder = [0, 1];
	hurtTimer = 0;
	battleEnded = false;
	winnerId = undefined;
	networkFinishHandled = false;

	constructor(changeScene) {
		this.changeScene = changeScene;
		this.stage = new KenStage();
		this.entities = new EntityList();
		this.overlays = [
			new StatusBar(this.fighters, this.onTimeEnd),
			new FpsCounter(),
		];
		resetGameState();
		this.startRound();
		window.STREETFIGHTER_BATTLE = {
			getNetworkSnapshot: this.getNetworkSnapshot,
			applyNetworkSnapshot: this.applyNetworkSnapshot,
		};
	}

	getFighterClass = (id) => {
		switch (id) {
			case FighterId.KEN:
				return Ken;
			case FighterId.RYU:
				return Ryu;
			default:
				return new Error('Invalid Fighter Id');
		}
	};

	getFighterEntitiy = (id, index) => {
		const FighterClass = this.getFighterClass(id);
		return new FighterClass(index, this.handleAttackHit, this.entities);
	};

	getFighterEntities = () => {
		const fighterEntities = gameState.fighters.map(({ id }, index) => {
			const fighterEntity = this.getFighterEntitiy(id, index);
			gameState.fighters[index].instance = fighterEntity;
			return fighterEntity;
		});

		fighterEntities[0].opponent = fighterEntities[1];
		fighterEntities[1].opponent = fighterEntities[0];

		return fighterEntities;
	};

	updateFighters = (time, context) => {
		this.fighters.map((fighter) => {
			if (this.hurtTimer > time.previous) {
				fighter.updateHurtShake(time, this.hurtTimer);
			} else fighter.update(time, this.camera);
		});
	};

	getHitSplashClass = (strength) => {
		switch (strength) {
			case FighterAttackStrength.LIGHT:
				return LightHitSplash;
			case FighterAttackStrength.MEDIUM:
				return MediumHitSplash;
			case FighterAttackStrength.HEAVY:
				return HeavyHitSplash;
			default:
				return new Error('Invalid Strength Splash requested');
		}
	};

	handleAttackHit = (time, playerId, opponentId, position, strength) => {
		this.FighterDrawOrder = [opponentId, playerId];
		gameState.fighters[playerId].score += FighterAttackBaseData[strength].score;

		gameState.fighters[opponentId].hitPoints -=
			FighterAttackBaseData[strength].damage;

		const HitSplashClass = this.getHitSplashClass(strength);

		if (gameState.fighters[opponentId].hitPoints <= 0) {
			this.fighters[opponentId].changeState(FighterState.KO, time);
		}

		this.fighters[opponentId].direction =
			this.fighters[playerId].direction * -1;

		position &&
			this.entities.add(HitSplashClass, position.x, position.y, playerId);

		this.hurtTimer = time.previous + FighterStruckDelay * FRAME_TIME;
	};

	updateShadows = (time) => {
		this.shadows.map((shadow) => shadow.update(time));
	};

	startRound = () => {
		this.networkFinishHandled = false;
		this.fighters = this.getFighterEntities();
		this.camera = new Camera(
			STAGE_PADDING + STAGE_MID_POINT - SCENE_WIDTH / 2,
			16,
			this.fighters
		);

		this.shadows = this.fighters.map((fighter) => new Shadow(fighter));
	};

	goToStartScene = () => {
		setTimeout(() => {
			this.changeScene(StartScene);
		}, 6000);
	};

	drawWinnerText = (context, id) => {
		context.drawImage(this.image, 0, 11 * id, 70, 9, 120, 60, 140, 30);
	};

	onTimeEnd = (time) => {
		if (gameState.fighters[0].hitPoints >= gameState.fighters[1].hitPoints) {
			this.fighters[0].victory = true;
			this.fighters[1].changeState(FighterState.KO, time);
			this.winnerId = 0;
		} else {
			this.fighters[1].victory = true;
			this.fighters[0].changeState(FighterState.KO, time);
			this.winnerId = 1;
		}
		window.dispatchEvent(
			new CustomEvent('streetfighter:winner', {
				detail: { winnerIndex: this.winnerId },
			})
		);
		this.goToStartScene();
	};

	updateOverlays = (time) => {
		this.overlays.map((overlay) => overlay.update(time));
	};

	updateFighterHP = (time) => {
		gameState.fighters.map((fighter, index) => {
			if (fighter.hitPoints <= 0 && !this.battleEnded) {
				this.fighters[index].opponent.victory = true;
				this.winnerId = 1 - index;
				this.battleEnded = true;
				window.dispatchEvent(
					new CustomEvent('streetfighter:winner', {
						detail: { winnerIndex: this.winnerId },
					})
				);
				this.goToStartScene();
			}
		});
	};

	getStatusBar = () => this.overlays.find((overlay) => 'time' in overlay);

	getNetworkSnapshot = () => ({
		time: this.getStatusBar()?.time ?? 99,
		battleEnded: this.battleEnded,
		winnerId: this.winnerId ?? null,
		camera: {
			x: this.camera.position.x,
			y: this.camera.position.y,
		},
		fighters: this.fighters.map((fighter, index) => ({
			position: {
				x: fighter.position.x,
				y: fighter.position.y,
			},
			velocity: {
				x: fighter.velocity.x,
				y: fighter.velocity.y,
			},
			direction: fighter.direction,
			currentState: fighter.currentState,
			animationFrame: fighter.animationFrame,
			hitPoints: gameState.fighters[index].hitPoints,
			score: gameState.fighters[index].score,
			victory: fighter.victory,
		})),
		fireballs: this.entities.entitiesList
			.filter((entity) => entity instanceof Fireball)
			.map((fireball) => ({
				ownerId: fireball.fighter.playerId,
				strength: fireball.strength,
				position: {
					x: fireball.position.x,
					y: fireball.position.y,
				},
				direction: fireball.direction,
				currentState: fireball.currentState,
				animationFrame: fireball.animationFrame,
			})),
	});

	applyNetworkSnapshot = (snapshot = {}, { preserveAnimations = false } = {}) => {
		if (!snapshot || !Array.isArray(snapshot.fighters)) return;
		const statusBar = this.getStatusBar();
		if (statusBar && Number.isFinite(Number(snapshot.time))) {
			statusBar.time = Number(snapshot.time);
			statusBar.startingHealthRollUpDone = true;
		}
		if (snapshot.camera) {
			this.camera.position.x = Number(snapshot.camera.x ?? this.camera.position.x);
			this.camera.position.y = Number(snapshot.camera.y ?? this.camera.position.y);
		}
		if (preserveAnimations) this.applyNetworkFireballs(snapshot.fireballs);
		this.battleEnded = snapshot.battleEnded === true;
		this.winnerId =
			snapshot.winnerId === null || snapshot.winnerId === undefined
				? undefined
				: Number(snapshot.winnerId);

		snapshot.fighters.slice(0, 2).forEach((fighterState, index) => {
			const fighter = this.fighters[index];
			if (!fighter || !fighterState) return;
			fighter.position.x = Number(fighterState.position?.x ?? fighter.position.x);
			fighter.position.y = Number(fighterState.position?.y ?? fighter.position.y);
			fighter.velocity.x = Number(fighterState.velocity?.x ?? fighter.velocity.x);
			fighter.velocity.y = Number(fighterState.velocity?.y ?? fighter.velocity.y);
			fighter.direction = Number(fighterState.direction) < 0 ? -1 : 1;
			fighter.victory = fighterState.victory === true;
			if (!preserveAnimations && fighter.animations[fighterState.currentState]) {
				fighter.currentState = fighterState.currentState;
				fighter.setAnimationFrame(
					Number(fighterState.animationFrame || 0),
					{ previous: 0 }
				);
			}
			gameState.fighters[index].hitPoints = Number(
				fighterState.hitPoints ?? gameState.fighters[index].hitPoints
			);
			gameState.fighters[index].score = Number(
				fighterState.score ?? gameState.fighters[index].score
			);
			if (statusBar?.healthBars?.[index]) {
				statusBar.healthBars[index].hitPoints = gameState.fighters[index].hitPoints;
			}
		});
		if (this.battleEnded && !this.networkFinishHandled) {
			this.networkFinishHandled = true;
			this.applyNetworkFinish();
		}
	};

	applyNetworkFinish = () => {
		if (this.winnerId !== 0 && this.winnerId !== 1) return;
		const loserId = 1 - this.winnerId;
		const winner = this.fighters[this.winnerId];
		const loser = this.fighters[loserId];
		if (winner) winner.victory = true;
		if (loser) loser.changeState(FighterState.KO, { previous: 0 });
		this.goToStartScene();
	};

	applyNetworkFireballs = (states = []) => {
		const fireballs = Array.isArray(states) ? states : [];
		const ownerIds = new Set(
			fireballs
				.map((state) => Number(state?.ownerId))
				.filter((ownerId) => Number.isInteger(ownerId) && this.fighters[ownerId])
		);
		this.entities.entitiesList = this.entities.entitiesList.filter(
			(entity) =>
				!(
					entity instanceof Fireball &&
					entity.networkControlled &&
					!ownerIds.has(entity.fighter.playerId)
				)
		);

		for (const state of fireballs) {
			const ownerId = Number(state?.ownerId);
			if (!Number.isInteger(ownerId) || !this.fighters[ownerId]) continue;
			let fireball = this.entities.entitiesList.find(
				(entity) =>
					entity instanceof Fireball && entity.fighter.playerId === ownerId
			);
			if (!fireball) {
				fireball = new Fireball(
					this.fighters[ownerId],
					Number(state.strength) || 1,
					{ previous: 0 },
					this.entities
				);
				this.entities.entitiesList.push(fireball);
			}
			fireball.applyNetworkState(state);
		}
	};

	update = (time) => {
		this.updateFighters(time);
		this.updateShadows(time);
		this.stage.update(time);
		this.entities.update(time, this.camera);
		this.camera.update(time);
		this.updateOverlays(time);
		this.updateFighterHP(time);
	};

	drawFighters(context) {
		this.FighterDrawOrder.map((id) =>
			this.fighters[id].draw(context, this.camera)
		);
	}

	drawShadows(context) {
		this.shadows.map((shadow) => shadow.draw(context, this.camera));
	}

	drawOverlays(context) {
		this.overlays.map((overlay) => overlay.draw(context, this.camera));
		if (this.winnerId !== undefined) {
			this.drawWinnerText(context, this.winnerId);
		}
	}

	draw = (context) => {
		this.stage.drawBackground(context, this.camera);
		this.drawShadows(context);
		this.drawFighters(context);
		this.entities.draw(context, this.camera);
		this.stage.drawForeground(context, this.camera);
		this.drawOverlays(context);
	};
}
