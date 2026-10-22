Detect user is mobile or tablet so we can provide touch button and joystick for the players in all version frag and z_plus also.
1. for mobile user lets divide the screen into 2 part first is left side and right side
2. left side will have joystick which user can move ,right side empty space where user can move up/down/left/right camera movement
3. at bottom of screen have small 3 box type things for each gun ,which user can click and switch to that .
4. crouch to right side , then jump button, scope button , reload
5. user can sprint through joystick only , when moving forward with joystick then the sprint option will come just above the joystick user can simple click and character will start running.
6.  at right side give a option to shoot also when click will shoot
7. i have attach a example image how it will look.
8. when user move. close to car then drive or sitinside option will come the user which will be sitted can shoot not the driver [add this feature]
9. make helicopter and areoplane user can drive , also when there fuel get over it will just hit the ground and make explision if user leave quickly else inside user will also be damaged.according to vechile the icon will chnage on screen , like if in car mobile user will see forward backward left right and all, in flying ones it will have up/down move forard backward . depending on actual physisc and actual working.



Change the wave progression system so that waves are time-based instead of kill-based.

Currently, the next wave only starts after the player kills every zombie in the current wave.
Instead, make each wave advance automatically after a fixed amount of time (e.g., when the next night begins), regardless of how many zombies from the previous wave are still alive.
Any zombies that survive from earlier waves should remain active, while the new wave spawns on top of them.
This means zombies from multiple waves can coexist, creating a cumulative difficulty that increases over time.
The game should continue spawning stronger and larger waves each cycle based on elapsed time or the current wave number, not on whether all previous zombies have been eliminated.
The result should be a continuously escalating survival experience where players are overwhelmed if they cannot keep up with the increasing zombie population.

Environment Improvements

Expand the map to create a much stronger urban/city atmosphere instead of a mostly empty environment.
Add a variety of structures and locations, including:
Residential and commercial buildings
Apartment blocks and office buildings
Shops and storefronts
Playgrounds and parks
Parking lots
Roads, intersections, sidewalks, streetlights, traffic signals, and road signs
Bus stops and buses
Cars and trucks
A crashed or abandoned airplane (or a functional one if appropriate for gameplay)
Additional city props such as benches, trash bins, fences, billboards, and construction areas.
All new objects should have proper physics, collisions, and interactions consistent with the rest of the game. Vehicles, props, and structures should behave naturally without breaking existing gameplay.
Ensure the new environment remains optimized while significantly increasing immersion and making the city feel dense, alive, and suitable for a zombie survival experience.


create a flying zombie also ,which are intelligent , rather then just follwing they can doghe the bullete also and will have 1.5% more health then regural zombie ,also some zomibe and boss zombie comes highlisht the chararcter about it that boss appear and its excact location .also boss zombie and some random zombie have the ability to call more zombie which can attack character. ,also make zombie spawning more intersting like , zombie coming out from ground rather then just swaping .this make it look cool .

here add a new mode which is z+ mode, which will be accessable only when user visit /frag/z_plus route , here user will auto login inside the map with random user name ,map will be same ,nothing change ,just add day to night change in every 5 min ,here in this mode the zombie character will be intorudced which will attack user, @micro-football/description.md  contain some info related to it ,different zombie type , there waves ,and all ,what i need is random swaping and at day time less spwaning but in night time that swaping will double , create all different zombie and all other things 
This is the description file containing all the required things which are need to be implemented and need to done , create a sepearte folder where all content related to that will be there. Just make sure that it cover all type , the wave will start coming in 1 min when started the game. any player joined thorugh this will have random name

If you're building a zombie mode, avoid making all zombies simply run directly toward the player. That works for a prototype, but it quickly feels repetitive and can cause performance issues when many zombies are active.

A better approach is to use layered AI.

Level 1: State Machine (Recommended)

Give every zombie a few states.

Idle
 ↓
Patrol
 ↓
Investigate Noise
 ↓
Chase Player
 ↓
Attack
 ↓
Search Last Known Position
 ↓
Return to Patrol

Each state has its own behavior.

Idle → stand or wander.
Patrol → walk around predefined points.
Investigate → move toward sounds (gunshots, explosions).
Chase → pursue player.
Attack → when close enough.
Search → if player disappears behind walls.

This already feels much smarter than "always follow player."

Level 2: Vision + Hearing

Instead of always knowing the player's location, give zombies senses.

Vision
if distance < 20m
AND
angle < 90°
AND
no wall between zombie and player

-> Player Detected

Use a raycast to verify line of sight.

Hearing

Every action creates noise.

Example:

Walking = 2
Running = 5
Gunshot = 25
Explosion = 60

Nearby zombies receive the event.

Gun fired

↓

Zombie hears sound

↓

Moves to investigate

↓

If player seen

↓

Starts chasing

This creates interesting gameplay.

Level 3: Navigation Mesh

Don't manually move zombies.

Use a navigation system.

Zombie

↓

NavMesh Agent

↓

Find shortest path

↓

Avoid obstacles

↓

Reach player

Benefits:

avoids walls
avoids furniture
uses doors
climbs ramps

Every game engine has one.

Unity → NavMesh
Unreal → AI Navigation
Godot → NavigationAgent
Level 4: Zombie Types

Different zombies keep gameplay fresh.

Type	Behavior
Walker	Slow, always follows
Runner	Fast after spotting player
Tank	Slow but high HP
Screamer	Calls nearby zombies
Crawler	Comes from under objects
Jumper	Climbs windows
Level 5: Group Intelligence

Instead of every zombie independently chasing the player:

Player

     ↑
 Leader Zombie
  /    |    \
 Z1   Z2    Z3

Only one zombie calculates the best path.

Nearby zombies simply follow the leader with small offsets.

Benefits:

Less CPU usage
Looks like a horde
Natural movement
Level 6: Horde Manager (Very Important)

Don't update 300 zombies every frame.

Instead:

Visible zombies
Update every frame

Far zombies
Update every 0.5 sec

Very far
Update every 2 sec

Very far away
Sleep

This is how many large-scale games maintain performance.

Level 7: Spawn System

Never spawn all zombies immediately.

Instead:

Wave 1
10 zombies

↓

30 sec

↓

Wave 2
15 zombies

↓

Player reaches checkpoint

↓

Mini boss

↓

Final wave

Or spawn based on noise.

Explosion

↓

Spawn zombies from nearby buildings

↓

Player becomes surrounded
Level 8: Flanking

Instead of everyone taking the exact same route:

       Zombie

Zombie      Player      Zombie

       Zombie

Assign simple roles:

70% chase directly
20% move to the player's left/right
10% attempt to cut off escape

This makes encounters feel much more dynamic.

Level 9: Memory

A zombie shouldn't instantly forget the player.

Player seen

↓

Player hides

↓

Zombie moves to last known location

↓

Searches nearby

↓

If not found

↓

Returns to patrol

This feels much more believable.

Level 10: Dynamic Difficulty

Adjust zombie behavior based on player performance.

Player health low

↓

Fewer zombies spawn

Player dominating

↓

Spawn more runners

Player camping

↓

Spawn zombies behind

This keeps matches engaging without feeling unfair.

Overall AI Architecture
                Zombie Manager
                     │
     ┌───────────────┼───────────────┐
     │               │               │
 Spawn System   Horde Manager   Difficulty Manager
                     │
             Zombie AI Controller
                     │
          State Machine
                     │
      ┌──────────────┼──────────────┐
      │              │              │
 Vision         Hearing        Memory
      │              │              │
      └──────────────┼──────────────┘
                     │
              Navigation System
                     │
              Animation Controller
                     │
                  Zombie
For a small team or indie project

A practical combination that delivers good results without excessive complexity is:

Use a finite state machine (Patrol → Investigate → Chase → Attack → Search).
Use a NavMesh (or your engine's pathfinding) instead of manually moving zombies.
Add vision and hearing so zombies react naturally.
Manage groups with a Horde Manager that activates only nearby zombies and reduces update frequency for distant ones.
Introduce special zombie types (runner, tank, screamer) gradually to vary gameplay.

This approach scales well from a handful of zombies to large hordes and provides behavior that feels intelligent while remaining efficient to implement

There are well-known AI algorithms used in games, but they are usually combined rather than relying on a single algorithm.

Since you're using Three.js, here's what I would recommend.

1. Pathfinding (Most Important)

Instead of moving directly toward the player,

Zombie
   ↓
Find path
   ↓
Avoid walls
   ↓
Walk around obstacles
   ↓
Reach player

The standard algorithm is A* (A-Star).

It finds the shortest path between two points.

Example:

###########
# Zombie  #
# #####   #
#     #   #
#   Player#
###########

Without pathfinding:

Zombie
   →
Wall

Zombie gets stuck.

With A*:

Zombie
↓
↓
→→→
↓
Player
2. Navigation Mesh (Better than Grid)

Most modern FPS games don't use a square grid.

Instead they generate a NavMesh.

Floor

+----------------------+
|                      |
|      Walkable        |
|                      |
|   Table (Blocked)    |
|                      |
+----------------------+

The zombie walks only on walkable polygons.

For Three.js you can use:

three-pathfinding (built on Recast Navigation)
Recast Navigation
Yuka AI

These already use A* internally.

3. Steering Behaviors (Craig Reynolds)

This is one of the best algorithms for zombies.

Instead of

moveTo(player)

the movement is the combination of several forces.

Seek Player

+

Avoid Wall

+

Avoid Other Zombies

+

Keep Group

+

Randomness

=

Final Movement

This is called Steering Behaviors.

Popular behaviors:

Seek
Flee
Arrive
Wander
Separation
Cohesion
Alignment
Obstacle Avoidance

Games use these all the time.

Example

Suppose there are 100 zombies.

Without steering

P

ZZZZZZZZZZ

Every zombie occupies the same position.

Looks terrible.

With Separation

       Z

 Z           Z

      Player

 Z       Z      Z

       Z

They naturally spread around the player.

4. Finite State Machine (FSM)

Movement is not enough.

Behavior also matters.

Idle

↓

Patrol

↓

Hear Sound

↓

Investigate

↓

See Player

↓

Chase

↓

Attack

↓

Lost Player

↓

Search

↓

Patrol

Each state has different movement.

5. Behavior Tree

Large games often replace FSM with a Behavior Tree.

Example

Root

├── Is Player Visible?
│      │
│      ├── Yes
│      │      ├── Close?
│      │      │      ├── Attack
│      │      │
│      │      └── Chase
│      │
│      └── No
│             ├── Hear Noise?
│             │      ├── Investigate
│             │
│             └── Patrol

This scales better than an FSM when AI becomes complex.

6. Flow Field (Best for Huge Hordes)

If you have

500 zombies

running A* for every zombie is expensive.

Instead create one flow map.

← ← ← ←

↑ ↑ ↑ ↑

↑ Player ↑

→ → → →

Every zombie simply follows the arrows.

This is called a Flow Field.

Games like RTS titles often use this.

7. Influence Map

Suppose there is

Fire

Bomb

Electric Trap

Player

Create a map where every location has a score.

Fire       -100

Bomb        -50

Player      +100

Dark Area   +20

The zombie chooses the highest score.

This creates more believable decisions.

8. Utility AI

Instead of

IF player near
Attack

give every action a score.

Attack = 95

Search = 30

Run = 10

Idle = 0

Pick the highest score.

Many modern games use Utility AI because it's flexible.

9. Spatial Partitioning

If you have 300 zombies, don't check every zombie against every other zombie.

Use a Quadtree (2D) or Octree (3D).

World

+-----+-----+
|     |     |
| Z   |     |
+-----+-----+
|     | Z   |
|     |     |
+-----+-----+

Now each zombie only checks nearby zombies.

What I'd build for a Three.js FPS

A practical architecture is:

Player
    │
    ▼
Zombie Manager
    │
    ├── Spatial Partition (Octree)
    │
    ├── State Machine
    │
    ├── Vision Check
    │
    ├── Hearing System
    │
    ├── Pathfinding (NavMesh + A*)
    │
    ├── Steering Behaviors
    │
    └── Animation

Each zombie follows this update loop:

update(dt) {
    sensePlayer();        // Vision + hearing
    updateState();        // Idle, Chase, Attack...
    calculatePath();      // Only when needed
    applySteering();      // Avoid walls & other zombies
    move(dt);
    animate();
}
Libraries that fit well with Three.js
three-pathfinding: NavMesh generation and A* pathfinding.
Yuka: Game AI library with steering behaviors, state machines, and vision.
recast-navigation-js: JavaScript port of Recast/Detour, used for robust NavMesh pathfinding.
If your game has 100–500 zombies

I would avoid recalculating paths every frame. A common optimization is:

Recalculate a path only when the player has moved a significant distance (e.g. 2–5 meters), or every 0.5–1 second.
Every frame, use steering behaviors to follow the current path while avoiding other zombies and obstacles.
Sleep or update far-away zombies at a much lower frequency.

This combination is used in many commercial games because it balances intelligence with performance.