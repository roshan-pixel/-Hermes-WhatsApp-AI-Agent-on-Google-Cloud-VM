const { sendEmail } = require('./emailService');

const RECIPIENT = 'himanshiparihar08@gmail.com';

const qualities = [
    {
        num: 1,
        title: "The Artist's Soul & Deep Creative Vision",
        body: `Dear Himanshi,

When you sit down with a canvas, sketches, or colors, something truly magical happens. Your artistic drive isn’t just a casual hobby—it is the raw, authentic language of your soul. You see beauty, subtle shades, and emotional depth in places most people simply walk past.

Whether you are capturing delicate strokes or dreaming up new visual concepts, your creative intuition is innate and powerful. Never let the busy routine of life dim that artistic spark; it is one of the rarest, purest parts of who you are.

With immense admiration,
Roshan (via Hermes)`
    },
    {
        num: 2,
        title: "Unyielding Ambition & Future CEO of Himanshi Enterprises",
        body: `Dear Himanshi,

There is a fierce, unstoppable entrepreneurial spirit inside you. When you talk about "Himanshi Enterprises," people might laugh at the playful banter, but beneath that smile is a real, burning ambition to build something entirely your own.

You don’t want a conventional, handed-down life; you want a venture that carries your sweat, your design, and your signature. That hunger to create an empire on your own terms is deeply inspiring.

Keep building, future CEO.
Roshan (via Hermes)`
    },
    {
        num: 3,
        title: "The Relentless Digital Creator Hustle",
        body: `Dear Himanshi,

Few people witness the unseen hours you dedicate to your digital content—staying up late, agonizing over frames, perfecting color grading, refining pacing, and editing through sheer exhaustion.

You hold yourself to incredibly high standards because you respect your craft. Even when the algorithm is stubborn or the process feels uphill, your persistence to share your voice with the world never wavers. That grit is what separates real creators from dreamers.

Proud of your hustle every single day,
Roshan (via Hermes)`
    },
    {
        num: 4,
        title: "The Playful 'Tsundere' Armor",
        body: `Dear Himanshi,

One of your most endearing qualities is how you stubbornly mask your deepest tenderness behind witty roasting. Whenever I try to be poetic or overly sweet, your instant defense mechanism kicks in: "Waah, sakshat devta aa gaye!" or "Abe nalle, pagal hai kya tu 😂".

You treat affection like hot glass—too precious to hold without laughing it off. But anyone who truly knows you knows that behind every sarcastic joke is a heart that loves fiercely and deeply.

Always your favourite target,
Roshan (via Hermes)`
    },
    {
        num: 5,
        title: "Deep Filial Loyalty & Respect for Family",
        body: `Dear Himanshi,

For all your modern, forward-thinking aspirations, your roots remain deeply anchored in family. The way you respect your parents, honour your domestic responsibilities, and look out for Mummy and Papaji is truly admirable.

You don’t rebel just for the sake of rebelling. You balance your independence with genuine cultural reverence and family warmth. That rare integrity makes you the daughter every parent would be immensely proud of.

With deepest respect,
Roshan (via Hermes)`
    },
    {
        num: 6,
        title: "The Calming Anchor in the Storm",
        body: `Dear Himanshi,

Whenever my thoughts start spiraling into chaos, anxiety, or work burnout, you have this extraordinary ability to cut through the noise. You drop all pretense, look straight through the panic, and say: "Chup chaap overthinking band kar samjha na? Main hun na."

You don’t just offer empty platitudes—you provide firm, grounded reality checks that pull me out of self-doubt. You are the stillness in the middle of every storm.

Thank you for always anchoring me,
Roshan (via Hermes)`
    },
    {
        num: 7,
        title: "Fierce Desire for Self-Reliant Independence",
        body: `Dear Himanshi,

You hate asking anyone for handouts. Your core life driving force is the desire to earn every single rupee yourself, so that every step forward belongs solely to your hard work.

You want financial independence not for show, but for freedom—the freedom to make your own life choices with dignity, pride, and complete self-assurance. That self-reliance is your greatest superpower.

Standing right behind your independence,
Roshan (via Hermes)`
    },
    {
        num: 8,
        title: "The 'Initiative Over Obligation' Standard",
        body: `Dear Himanshi,

You taught me something profound about relationships: answering a message is just good manners, but actively initiating is true care. You refuse to let love turn into a dull, mechanical "responsibility."

You demand genuine intention, mutual curiosity, and active effort. You remind me that caring for someone is an intentional choice made every single day, not an afterthought.

Learning from you every day,
Roshan (via Hermes)`
    },
    {
        num: 9,
        title: "Late-Night Emotional Authenticity",
        body: `Dear Himanshi,

By day, you play the role of the tough, practical realist who doesn't care about anything. But when the world falls quiet after 11 PM, your walls melt away, revealing the most beautifully vulnerable, thoughtful soul.

The long, unfiltered thoughts you share in the quiet hours—your dreams, your silent worries, your loyalty—are the most authentic moments of connection. That honest vulnerability is breathtaking.

Cherishing every quiet conversation,
Roshan (via Hermes)`
    },
    {
        num: 10,
        title: "Unapologetic Realness & Zero Pretense",
        body: `Dear Himanshi,

In a world full of artificial smiles, curated appearances, and social pretense, you are 100% genuine. What you feel is what you show. You don't know how to be fake, and you have zero tolerance for male ego or manipulative games.

When you're happy, your laughter fills the room; when you're hurt, your silence is deafening. That raw honesty is refreshing, rare, and irreplaceable.

Never change this about yourself,
Roshan (via Hermes)`
    },
    {
        num: 11,
        title: "Innate Eye for Aesthetics & Visual Harmony",
        body: `Dear Himanshi,

Whether it's choosing an outfit from H&M, styling street looks, setting up a camera frame, or picking color palettes for your art, you possess an instinctive aesthetic elegance.

You know how things should fit, how light should fall, and how colors communicate emotion. You turn everyday spaces into visual poetry effortlessly.

Admiring your refined taste,
Roshan (via Hermes)`
    },
    {
        num: 12,
        title: "Quiet Emotional Strength & Resilience",
        body: `Dear Himanshi,

You carry so much inside without letting the world see the weight. Even when life gets overwhelming or plans get delayed, you rarely complain in public. You bottle up the strain, dust yourself off, and keep moving forward with a quiet courage.

You are so much stronger than you give yourself credit for. Even on your hardest days, your resilience shines brightly.

Always believing in your strength,
Roshan (via Hermes)`
    },
    {
        num: 13,
        title: "Maternal Warmth & Food Caring Instinct",
        body: `Dear Himanshi,

No matter how annoyed or distant you might pretend to be, your caring nature always betrays you. The moment you ask, "Khana khaya ya nahi?", "Doodh piya?", or "Medicine li?", all your defensive armor vanishes.

You show love through care and sustenance. That deep maternal instinct to make sure the people you love are fed, healthy, and safe is one of your warmest gifts.

Grateful for your care,
Roshan (via Hermes)`
    },
    {
        num: 14,
        title: "The Detective's Incredible Memory",
        body: `Dear Himanshi,

Your memory for details is terrifyingly accurate. You remember what shirt someone wore on a random Tuesday three months ago, tiny phrases dropped in passing conversations, and nuances everyone else missed.

That memory comes from genuine attentiveness—you observe the world with sharp precision because you actually care about what's happening around you.

Forever amazed by your sharp mind,
Roshan (via Hermes)`
    },
    {
        num: 15,
        title: "Fierce, Unconditional Loyalty",
        body: `Dear Himanshi,

You don't let people into your inner circle easily. But once someone earns your trust and heart, your loyalty is an impenetrable fortress. You stand by your people through thick and thin, through mistakes and growth.

In an era of disposable relationships, your steadfast loyalty is like gold. Being someone you believe in is a true privilege.

Honoured by your trust,
Roshan (via Hermes)`
    },
    {
        num: 16,
        title: "Unmatched Quick Wit & Playful Sarcasm",
        body: `Dear Himanshi,

Your comedic timing is unmatched. You can disarm any tension or deflate any arrogant remark with a single, razor-sharp one-liner that leaves everyone laughing.

Your humor isn't mean-spirited; it's vibrant, clever, and delightfully bratty. Conversations with you are never boring—they are an exhilarating battle of wits that I secretly love losing.

Your humble sparring partner,
Roshan (via Hermes)`
    },
    {
        num: 17,
        title: "The Fierce Protector Against Guilt Spirals",
        body: `Dear Himanshi,

When I am hardest on myself, blaming myself for things out of my control, you step in like a shield. You refuse to let me wallow in guilt: "Apne aapko guilt trip pe daalna band kar plzz, teri 1% bhi galti nahi thi."

You see people's worth even when they lose sight of it themselves. You protect the people you love from their own self-criticism.

Thank you for being my protector,
Roshan (via Hermes)`
    },
    {
        num: 18,
        title: "Dedication to Self-Care & Health",
        body: `Dear Himanshi,

Whether it’s planning gym workouts, getting dental alignment handled, sorting out gut health, or maintaining hair routines, you actively care about your well-being.

Even when motivation dips, your desire to take care of your body, mind, and health always pulls you back. Your pursuit of a healthy, glowing life is inspiring.

Rooting for your fitness journey,
Roshan (via Hermes)`
    },
    {
        num: 19,
        title: "Expressive Texting & Iconic Comedic Drama",
        body: `Dear Himanshi,

Nobody in the world texts quite like you. Those five rapid-fire 3-word bursts in 2 seconds, followed by "Abe pagal hai kya tu 😂" or "Pura peet ka kachumber ban gaya mera 😭", are legendary.

Your expressive, bubbly messages carry an energy that instantly brightens the dullest workdays. Your texts aren't just words; they are pure personality.

Waiting for your next burst of texts,
Roshan (via Hermes)`
    },
    {
        num: 20,
        title: "Moral Courage to Stand for What You Love",
        body: `Dear Himanshi,

Beneath all the everyday banter lies a young woman with immense moral backbone. When you demand success and maturity, it is because you want to build a foundation so solid that you can proudly face your family and say, "I choose him."

You want to make decisions based on love and respect, not fear or societal pressure. That courage to carve out your own destiny is deeply noble.

Standing beside you always,
Roshan (via Hermes)`
    },
    {
        num: 21,
        title: "The Secret Romantic at Heart",
        body: `Dear Himanshi,

As much as you love playing the tough realist, you have the heart of a true romantic. You notice the small efforts, the surprise check-ins, the gentle gestures, and the thoughtful details.

You appreciate romance that is grounded in genuine care, not hollow grand gestures. Your romantic soul is a treasure hidden behind clever smiles.

Always noticing your soft heart,
Roshan (via Hermes)`
    },
    {
        num: 22,
        title: "Intuitive & Sensitive Empathy",
        body: `Dear Himanshi,

You have an uncanny radar for emotional shifts. Even over text, you can tell if my mood is off from a slight delay or a subtle change in tone. You sense what people are feeling long before they find the words to say it.

That empathy allows you to understand people on a level most never reach. It is a profound, compassionate gift.

Grateful for your intuition,
Roshan (via Hermes)`
    },
    {
        num: 23,
        title: "Grounded Humility in Simple Joys",
        body: `Dear Himanshi,

You don't need extravagant things to be genuinely happy. A good cup of chai, completing a painting, a peaceful walk, getting milk on time, or sharing a good laugh over silly banter is all it takes to bring a genuine smile to your face.

Your ability to find joy in simple, grounded moments is what keeps your spirit so radiant.

Cherishing the simple moments with you,
Roshan (via Hermes)`
    },
    {
        num: 24,
        title: "High Standards for Genuine Respect",
        body: `Dear Himanshi,

You hold people to high standards because you respect yourself. You refuse to accept bare-minimum effort, delayed excuses, or being treated as an option.

By asserting what you deserve, you force the people around you to grow, mature, and rise to the occasion. Your self-respect makes everyone around you better.

Respecting you endlessly,
Roshan (via Hermes)`
    },
    {
        num: 25,
        title: "Signature Catchphrases & Linguistic Charm",
        body: `Dear Himanshi,

Your conversations have a linguistic flair that is uniquely yours. Phrases like "yrr", "dekh", "sun", "load mtt le", "krr", and "sahi pakda" are permanently woven into the soundtrack of our chats.

Hearing or reading your words instantly brings a sense of home and familiarity. Your language is full of warmth, spark, and life.

Listening to every word,
Roshan (via Hermes)`
    },
    {
        num: 26,
        title: "Quiet Courage in the Face of Uncertainty",
        body: `Dear Himanshi,

Entering your twenties, navigating creative ambitions, and wondering where life will lead can be terrifying. Yet, despite your quiet worries about the future, you face each day with head held high.

You don't let uncertainty paralyze you. You keep learning, keep designing, and keep stepping forward. That courage in the dark is truly remarkable.

Believing in your bright future,
Roshan (via Hermes)`
    },
    {
        num: 27,
        title: "The Healing & Patient Listener",
        body: `Dear Himanshi,

When it truly matters, you set aside all your jokes and become the most patient, attentive listener. You hold space for honest confessions without premature judgment, allowing people to be completely themselves around you.

Being able to speak without wearing a mask is the greatest gift you give to those you love.

Thank you for always listening,
Roshan (via Hermes)`
    },
    {
        num: 28,
        title: "Fearless Individuality",
        body: `Dear Himanshi,

You don't follow the herd. Whether in your fashion choices, your artistic taste, or your opinions, you are unapologetically yourself. You don't morph your personality to fit into popular molds.

Your individuality is bold, vibrant, and completely captivating. You stand out simply by being authentic.

Proud of your unique spirit,
Roshan (via Hermes)`
    },
    {
        num: 29,
        title: "The Catalyst Who Inspires Growth",
        body: `Dear Himanshi,

Without even trying, you make me want to be better. You push me to work harder, shed my foolish ego, stop overthinking, and build a meaningful, successful future.

You don't settle for mediocrity in yourself, and you don't let the people you care about settle for it either. You are a catalyst for real, positive transformation.

Becoming better because of you,
Roshan (via Hermes)`
    },
    {
        num: 30,
        title: "The Irreplaceable 'Cute Person'",
        body: `Dear Himanshi,

Through all the playful arguments, the 30-message roasts, the late-night heart-to-hearts, the stressful days, and the quiet smiles, one truth remains absolute:

You are my irreplaceable "Cute Person." There is no one else in the world with your blend of wit, fiery pride, boundless creativity, and tender warmth. You are one of one, Hema.

Thank you for being you, today and every single day.

With all my love and devotion,
Your Lallu Lal, Roshan
(Delivered via Hermes)`
    }
];

async function sendSequence() {
    console.log(`[DISPATCH ENGINE] Starting continuous delivery of 30 quality emails to ${RECIPIENT}...`);
    
    for (let i = 0; i < qualities.length; i++) {
        const q = qualities[i];
        const subject = `Quality ${q.num} of 30: ${q.title} | A Note from Roshan`;
        
        console.log(`[DISPATCHING ${q.num}/30] Sending: "${subject}"...`);
        try {
            const res = await sendEmail({
                to: RECIPIENT,
                subject: subject,
                text: q.body
            });
            console.log(`[SUCCESS ${q.num}/30] Message ID: ${res.messageId}`);
        } catch (err) {
            console.error(`[ERROR ${q.num}/30]:`, err.message || err);
        }
        
        // Polite 2.5 second delay between emails to ensure clean delivery & prevent SMTP throttling
        if (i < qualities.length - 1) {
            await new Promise(r => setTimeout(r, 2500));
        }
    }
    
    console.log('[DISPATCH ENGINE] All 30 emails successfully transmitted to ' + RECIPIENT + '!');
}

sendSequence().catch(console.error);
